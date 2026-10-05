import { db } from "./db.ts";
import { GATHER_YIELD } from "./balance.ts";

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
