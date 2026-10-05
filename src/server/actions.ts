import { db } from "./db.ts";
import { GATHER_YIELD, REPRODUCE_COST } from "./balance.ts";

export type ActionResult = { ok: true } | { ok: false; error: string };

export function gather(workerId: number, nodeId: number): ActionResult {
  const worker = db.prepare("SELECT id, colony_id AS colonyId FROM workers WHERE id = ?").get(workerId) as
    | { id: number; colonyId: number }
    | undefined;
  if (!worker) return { ok: false, error: "no such worker" };

  const node = db.prepare("SELECT id FROM resource_nodes WHERE id = ?").get(nodeId) as { id: number } | undefined;
  if (!node) return { ok: false, error: "no such resource node" };

  db.prepare("UPDATE colonies SET protein = protein + ? WHERE id = ?").run(GATHER_YIELD, worker.colonyId);
  return { ok: true };
}

export function reproduce(colonyId: number): ActionResult {
  const colony = db
    .prepare("SELECT protein, queen_x AS queenX, queen_y AS queenY FROM colonies WHERE id = ?")
    .get(colonyId) as { protein: number; queenX: number; queenY: number } | undefined;
  if (!colony) return { ok: false, error: "no such colony" };
  if (colony.protein < REPRODUCE_COST) return { ok: false, error: "not enough protein" };

  const tx = db.transaction(() => {
    db.prepare("UPDATE colonies SET protein = protein - ? WHERE id = ?").run(REPRODUCE_COST, colonyId);
    db.prepare("INSERT INTO workers (colony_id, x, y) VALUES (?, ?, ?)").run(colonyId, colony.queenX, colony.queenY);
  });
  tx();
  return { ok: true };
}
