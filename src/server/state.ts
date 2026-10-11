import { RESOURCE_TYPES } from "./balance.ts";
import { db } from "./db.ts";
import { getWorkersForColony, type Carrying } from "./simulation.ts";

export interface ColonyState {
  world: { width: number; height: number };
  colony: {
    id: number;
    queenX: number;
    queenY: number;
    resources: Record<string, number>;
  };
  workers: { id: number; x: number; y: number; carrying: Carrying }[];
  resourceNodes: {
    id: number;
    x: number;
    y: number;
    resourceType: string;
    amount: number | null;
    maxAmount: number | null;
  }[];
}

export function getState(): ColonyState {
  const world = db.prepare("SELECT id, width, height FROM worlds LIMIT 1").get() as
    | { id: number; width: number; height: number }
    | undefined;
  if (!world) throw new Error("no world seeded");

  const colonyRow = db
    .prepare("SELECT id, queen_x AS queenX, queen_y AS queenY FROM colonies LIMIT 1")
    .get() as { id: number; queenX: number; queenY: number } | undefined;
  if (!colonyRow) throw new Error("no colony seeded");

  const resourceRows = db
    .prepare("SELECT resource_type AS resourceType, amount FROM colony_resources WHERE colony_id = ?")
    .all(colonyRow.id) as { resourceType: string; amount: number }[];
  const resources: Record<string, number> = Object.fromEntries(RESOURCE_TYPES.map((type) => [type, 0]));
  for (const row of resourceRows) resources[row.resourceType] = row.amount;

  // Live positions come from in-memory simulation state, not straight from
  // SQLite — the table only ever holds the last checkpoint. See simulation.ts.
  const workers = getWorkersForColony(colonyRow.id);

  const resourceNodes = db
    .prepare(
      "SELECT id, x, y, resource_type AS resourceType, amount, max_amount AS maxAmount FROM resource_nodes WHERE world_id = ? ORDER BY id",
    )
    .all(world.id) as ColonyState["resourceNodes"];

  return {
    world: { width: world.width, height: world.height },
    colony: { id: colonyRow.id, queenX: colonyRow.queenX, queenY: colonyRow.queenY, resources },
    workers,
    resourceNodes,
  };
}
