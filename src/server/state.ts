import { type Caste, RESOURCE_TYPES } from "./balance.ts";
import { db } from "./db.ts";
import { type EvolutionChoice, type EvolutionSelections, getEvolutionModifiers, NO_EVOLUTION } from "./evolution.ts";
import {
  getAllColonies,
  getColonySnapshot,
  getCreaturesForWorld,
  getWorkersExcludingColony,
  getWorkersForColony,
  type Carrying,
} from "./simulation.ts";
import { getWorldEvents } from "./log.ts";
import { isRuinExpired } from "./ecology.ts";

const ALL_CASTES: Caste[] = ["worker", "soldier", "scout"];

export interface ColonyState {
  world: { width: number; height: number };
  colony: {
    id: number;
    queenX: number;
    queenY: number;
    resources: Record<string, number>;
    queenHealth: number;
    queenMaxHealth: number;
    status: "active" | "defeated";
    defeatCause: string | null;
    // Stage 9: the colony's own peak population, evolution selections, and
    // the live effective reproduction cost (always the number actually
    // deducted — see §17).
    peakPopulation: number;
    evolutionTier1: EvolutionChoice | null;
    evolutionTier2: EvolutionChoice | null;
    evolutionTier3: EvolutionChoice | null;
    // Stage 10: one effective cost per caste, each already Brood-discounted —
    // the displayed cost and the spent cost are always the same number per
    // caste, per §17/§34.
    reproduceCosts: Record<Caste, number>;
  };
  workers: { id: number; x: number; y: number; carrying: Carrying; health: number; maxHealth: number; caste: Caste }[];
  // Post-Stage-6b fix: every OTHER colony's workers, visible in the shared
  // world but never controllable by this session — kept as its own field
  // (not merged into `workers`) so "workers = my own colony, fully
  // selectable" stays an invariant the client can rely on structurally,
  // rather than something it has to remember to filter for. colonyId is the
  // public ownership tag the client needs to render these distinctly; no
  // session/cookie data is ever included here. Stage 7 adds health/maxHealth
  // here too — just a number, no new privacy concern.
  otherWorkers: {
    id: number;
    colonyId: number;
    x: number;
    y: number;
    carrying: Carrying;
    health: number;
    maxHealth: number;
    caste: Caste;
  }[];
  resourceNodes: {
    id: number;
    x: number;
    y: number;
    resourceType: string;
    amount: number;
    maxAmount: number;
    kind: "source" | "item";
  }[];
  creatures: { id: number; species: string; x: number; y: number; health: number; maxHealth: number }[];
  // Crit 10: every colony in the shared world, id + queen position only — no
  // resource ledger, which is private to its own owner. Lets a session see
  // that other players exist and where, without exposing their economy.
  // Stage 8 adds health/maxHealth/status — still no resources — so the
  // client can draw other queens' health bars and distinguish ruins.
  // Stage 9 §24/§25: population/peakPopulation/evolution/defeatCause let a
  // foreign colony's (or a ruin's) public evolutionary identity be shown —
  // never an internal modifier/stat, never session data.
  colonies: {
    id: number;
    queenX: number;
    queenY: number;
    health: number;
    maxHealth: number;
    status: "active" | "defeated";
    population: number;
    peakPopulation: number;
    evolutionTier1: EvolutionChoice | null;
    evolutionTier2: EvolutionChoice | null;
    evolutionTier3: EvolutionChoice | null;
    defeatCause: string | null;
  }[];
  // Stage 8: a small (<=6), curated, public feed — see log.ts's
  // getWorldEvents. No session/cookie data, never raw action_log detail.
  worldEvents: { message: string }[];
}

export function getState(colonyId: number): ColonyState {
  const world = db.prepare("SELECT id, width, height FROM worlds LIMIT 1").get() as
    | { id: number; width: number; height: number }
    | undefined;
  if (!world) throw new Error("no world seeded");

  const colonyRow = db
    .prepare("SELECT id, queen_x AS queenX, queen_y AS queenY, defeat_cause AS defeatCause FROM colonies WHERE id = ?")
    .get(colonyId) as { id: number; queenX: number; queenY: number; defeatCause: string | null } | undefined;
  if (!colonyRow) throw new Error("no such colony");

  // Stage 8: health/status come from the live in-memory cache, not this raw
  // SQL row — queen_health is only checkpointed periodically (see
  // simulation.ts's applyDamageToQueen/advanceQueenRegen split), so reading
  // it straight from SQLite here could show stale regen progress.
  const snapshot = getColonySnapshot(colonyRow.id);

  const resourceRows = db
    .prepare("SELECT resource_type AS resourceType, amount FROM colony_resources WHERE colony_id = ?")
    .all(colonyRow.id) as { resourceType: string; amount: number }[];
  const resources: Record<string, number> = Object.fromEntries(RESOURCE_TYPES.map((type) => [type, 0]));
  for (const row of resourceRows) resources[row.resourceType] = row.amount;

  // Live positions come from in-memory simulation state, not straight from
  // SQLite — the table only ever holds the last checkpoint. See simulation.ts.
  // Stage 10 (revised): fog of war is a client-side rendering concern only —
  // the server returns the full, unfiltered shared world to every colony.
  // Server authority is still total over *mutations* (ownership/caste/busy
  // checks in simulation.ts are untouched); it's just no longer the thing
  // deciding what a client is allowed to see. See CLAUDE.md's Stage 10
  // section for why this moved off the server (a non-indexed, per-colony
  // vision scan was the leading suspect for observed lag at scale).
  const workers = getWorkersForColony(colonyRow.id);

  const otherWorkers = getWorkersExcludingColony(colonyRow.id);

  const resourceNodes = db
    .prepare(
      "SELECT id, x, y, resource_type AS resourceType, amount, max_amount AS maxAmount, kind FROM resource_nodes WHERE world_id = ? ORDER BY id",
    )
    .all(world.id) as ColonyState["resourceNodes"];

  const creatures = getCreaturesForWorld(world.id);

  // defeat_cause/defeated_at are durable SQLite columns, never part of the
  // in-memory sim cache (they never change after defeat) — fetched once
  // here rather than threading them through getAllColonies()'s
  // per-tick-safe shape.
  const defeatInfo = new Map(
    (
      db.prepare("SELECT id, defeat_cause AS defeatCause, defeated_at AS defeatedAt FROM colonies").all() as {
        id: number;
        defeatCause: string | null;
        defeatedAt: string | null;
      }[]
    ).map((row) => [row.id, row]),
  );

  // Stage 10 (revised): every colony in the world is always included — fog
  // only governs client-side rendering, not what the server reports.
  // Stage 12: an expired ruin disappears from the live game view entirely —
  // same isRuinExpired gate ecology.ts uses for spawn exclusion, so a ruin's
  // visibility and its exclusion radius can never disagree.
  const colonies: ColonyState["colonies"] = getAllColonies()
    .filter((c) => c.status === "active" || !isRuinExpired(defeatInfo.get(c.id)?.defeatedAt ?? null))
    .map(({ id, x, y, health, maxHealth, status, population, peakPopulation, evolution }) => ({
      id,
      queenX: x,
      queenY: y,
      health,
      maxHealth,
      status,
      population,
      peakPopulation,
      evolutionTier1: evolution.tier1,
      evolutionTier2: evolution.tier2,
      evolutionTier3: evolution.tier3,
      defeatCause: defeatInfo.get(id)?.defeatCause ?? null,
    }));

  const worldEvents = getWorldEvents();

  const evolution: EvolutionSelections = snapshot?.evolution ?? NO_EVOLUTION;
  const reproduceCosts = Object.fromEntries(
    ALL_CASTES.map((caste) => [caste, getEvolutionModifiers(evolution, caste).reproduceCost]),
  ) as Record<Caste, number>;

  return {
    world: { width: world.width, height: world.height },
    colony: {
      id: colonyRow.id,
      // Stage 13A: like queenHealth/status below, these must track the live
      // snapshot, not this stale raw-SQL row — colonyRow.queen_x/queen_y are
      // only checkpointed periodically (see simulation.ts's
      // advanceQueenMovement/checkpointSimulation), so a moving queen would
      // otherwise appear frozen/snap back to her own owner.
      queenX: snapshot?.x ?? colonyRow.queenX,
      queenY: snapshot?.y ?? colonyRow.queenY,
      resources,
      queenHealth: snapshot?.health ?? 0,
      queenMaxHealth: snapshot?.maxHealth ?? 0,
      status: snapshot?.status ?? "defeated",
      defeatCause: colonyRow.defeatCause,
      peakPopulation: snapshot?.peakPopulation ?? 0,
      evolutionTier1: evolution.tier1,
      evolutionTier2: evolution.tier2,
      evolutionTier3: evolution.tier3,
      reproduceCosts,
    },
    workers,
    otherWorkers,
    resourceNodes,
    creatures,
    colonies,
    worldEvents,
  };
}
