import { db } from "./db.ts";

export interface ColonyState {
  colony: { id: number; protein: number; queenX: number; queenY: number };
  workers: { id: number; x: number; y: number }[];
  resourceNodes: { id: number; x: number; y: number; resourceType: string }[];
}

export function getState(): ColonyState {
  const colony = db
    .prepare("SELECT id, protein, queen_x AS queenX, queen_y AS queenY FROM colonies LIMIT 1")
    .get() as ColonyState["colony"] | undefined;
  if (!colony) throw new Error("no colony seeded");

  const workers = db
    .prepare("SELECT id, x, y FROM workers WHERE colony_id = ? ORDER BY id")
    .all(colony.id) as ColonyState["workers"];

  const resourceNodes = db
    .prepare("SELECT id, x, y, resource_type AS resourceType FROM resource_nodes ORDER BY id")
    .all() as ColonyState["resourceNodes"];

  return { colony, workers, resourceNodes };
}
