import { type Caste, RESOURCE_TYPES } from "./balance.ts";
import { db } from "./db.ts";
import { type EvolutionChoice, type EvolutionSelections, getEvolutionModifiers, NO_EVOLUTION } from "./evolution.ts";
import {
  getAllColonies,
  getColonySnapshot,
  getCreaturesForWorld,
  getVisionSources,
  getWorkersExcludingColony,
  getWorkersForColony,
  isVisible,
  type Carrying,
} from "./simulation.ts";
import { getWorldEvents } from "./log.ts";

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
    amount: number | null;
    maxAmount: number | null;
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
  // Stage 10: own data (workers/colony) is never fog-filtered — only ever
  // the OTHER colonies'/world's spatial entities below, per §16.
  const workers = getWorkersForColony(colonyRow.id);

  const visionSources = getVisionSources(colonyRow.id);
  const otherWorkers = getWorkersExcludingColony(colonyRow.id).filter((w) => isVisible(w.x, w.y, visionSources));

  const resourceNodes = (
    db
      .prepare(
        "SELECT id, x, y, resource_type AS resourceType, amount, max_amount AS maxAmount, kind FROM resource_nodes WHERE world_id = ? ORDER BY id",
      )
      .all(world.id) as ColonyState["resourceNodes"]
  ).filter((n) => isVisible(n.x, n.y, visionSources));

  const creatures = getCreaturesForWorld(world.id).filter((c) => isVisible(c.x, c.y, visionSources));

  // defeat_cause is a durable SQLite column, never part of the in-memory sim
  // cache (it never changes after defeat) — fetched once here rather than
  // threading it through getAllColonies()'s per-tick-safe shape.
  const defeatCauses = new Map(
    (db.prepare("SELECT id, defeat_cause AS defeatCause FROM colonies").all() as { id: number; defeatCause: string | null }[]).map(
      (row) => [row.id, row.defeatCause],
    ),
  );

  // Stage 10 §17/§23: a foreign colony (active queen or ruin) is only
  // included when it falls inside this colony's own vision — except this
  // colony's own entry, always included regardless of geometry (own-ness,
  // not position, gates it — keeps a defeated viewer's own ruin visible to
  // themselves).
  const colonies: ColonyState["colonies"] = getAllColonies()
    .filter((c) => c.id === colonyRow.id || isVisible(c.x, c.y, visionSources))
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
      defeatCause: defeatCauses.get(id) ?? null,
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
      queenX: colonyRow.queenX,
      queenY: colonyRow.queenY,
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
