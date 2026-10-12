import { RESOURCE_TYPES } from "./balance.ts";
import { db } from "./db.ts";
import { getCreaturesForWorld, getWorkersExcludingColony, getWorkersForColony, type Carrying } from "./simulation.ts";

export interface ColonyState {
  world: { width: number; height: number };
  colony: {
    id: number;
    queenX: number;
    queenY: number;
    resources: Record<string, number>;
  };
  workers: { id: number; x: number; y: number; carrying: Carrying }[];
  // Post-Stage-6b fix: every OTHER colony's workers, visible in the shared
  // world but never controllable by this session — kept as its own field
  // (not merged into `workers`) so "workers = my own colony, fully
  // selectable" stays an invariant the client can rely on structurally,
  // rather than something it has to remember to filter for. colonyId is the
  // public ownership tag the client needs to render these distinctly; no
  // session/cookie data is ever included here.
  otherWorkers: { id: number; colonyId: number; x: number; y: number; carrying: Carrying }[];
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
  colonies: { id: number; queenX: number; queenY: number }[];
}

export function getState(colonyId: number): ColonyState {
  const world = db.prepare("SELECT id, width, height FROM worlds LIMIT 1").get() as
    | { id: number; width: number; height: number }
    | undefined;
  if (!world) throw new Error("no world seeded");

  const colonyRow = db
    .prepare("SELECT id, queen_x AS queenX, queen_y AS queenY FROM colonies WHERE id = ?")
    .get(colonyId) as { id: number; queenX: number; queenY: number } | undefined;
  if (!colonyRow) throw new Error("no such colony");

  const resourceRows = db
    .prepare("SELECT resource_type AS resourceType, amount FROM colony_resources WHERE colony_id = ?")
    .all(colonyRow.id) as { resourceType: string; amount: number }[];
  const resources: Record<string, number> = Object.fromEntries(RESOURCE_TYPES.map((type) => [type, 0]));
  for (const row of resourceRows) resources[row.resourceType] = row.amount;

  // Live positions come from in-memory simulation state, not straight from
  // SQLite — the table only ever holds the last checkpoint. See simulation.ts.
  const workers = getWorkersForColony(colonyRow.id);
  const otherWorkers = getWorkersExcludingColony(colonyRow.id);

  const resourceNodes = db
    .prepare(
      "SELECT id, x, y, resource_type AS resourceType, amount, max_amount AS maxAmount, kind FROM resource_nodes WHERE world_id = ? ORDER BY id",
    )
    .all(world.id) as ColonyState["resourceNodes"];

  const creatures = getCreaturesForWorld(world.id);

  const colonies = db
    .prepare("SELECT id, queen_x AS queenX, queen_y AS queenY FROM colonies ORDER BY id")
    .all() as ColonyState["colonies"];

  return {
    world: { width: world.width, height: world.height },
    colony: { id: colonyRow.id, queenX: colonyRow.queenX, queenY: colonyRow.queenY, resources },
    workers,
    otherWorkers,
    resourceNodes,
    creatures,
    colonies,
  };
}
