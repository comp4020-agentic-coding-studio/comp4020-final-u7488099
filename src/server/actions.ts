import { GATHER_YIELD, REPRODUCE_COST } from "./balance.ts";
import { db } from "./db.ts";
import { registerWorker } from "./simulation.ts";

export type ActionResult = { ok: true } | { ok: false; error: string };

// Transitional (Stage 1): there's no travel, claiming or depletion yet, so
// gather is still the old instant, non-spatial Crit 8/9 RPC — it just now
// credits whichever colony_resources bucket matches the clicked node's
// resource_type, instead of always incrementing one flat protein column. It
// does not move the worker, claim the node, or touch the node's `amount`.
// Stage 4 replaces this with real travel + claim + carry + deposit.
export function gather(workerId: number, nodeId: number): ActionResult {
  const worker = db.prepare("SELECT id, colony_id AS colonyId FROM workers WHERE id = ?").get(workerId) as
    | { id: number; colonyId: number }
    | undefined;
  if (!worker) return { ok: false, error: "no such worker" };

  const node = db.prepare("SELECT resource_type AS resourceType FROM resource_nodes WHERE id = ?").get(nodeId) as
    | { resourceType: string }
    | undefined;
  if (!node) return { ok: false, error: "no such resource node" };

  db.prepare(
    `INSERT INTO colony_resources (colony_id, resource_type, amount) VALUES (?, ?, ?)
     ON CONFLICT(colony_id, resource_type) DO UPDATE SET amount = amount + excluded.amount`,
  ).run(worker.colonyId, node.resourceType, GATHER_YIELD);
  return { ok: true };
}

export function reproduce(colonyId: number): ActionResult {
  const colony = db
    .prepare("SELECT queen_x AS queenX, queen_y AS queenY FROM colonies WHERE id = ?")
    .get(colonyId) as { queenX: number; queenY: number } | undefined;
  if (!colony) return { ok: false, error: "no such colony" };

  const protein = db
    .prepare("SELECT amount FROM colony_resources WHERE colony_id = ? AND resource_type = 'protein'")
    .get(colonyId) as { amount: number } | undefined;
  if (!protein || protein.amount < REPRODUCE_COST) return { ok: false, error: "not enough protein" };

  let newWorkerId = 0;
  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE colony_resources SET amount = amount - ? WHERE colony_id = ? AND resource_type = 'protein'",
    ).run(REPRODUCE_COST, colonyId);
    const info = db
      .prepare("INSERT INTO workers (colony_id, x, y) VALUES (?, ?, ?)")
      .run(colonyId, colony.queenX, colony.queenY);
    newWorkerId = Number(info.lastInsertRowid);
  });
  tx();
  // Synchronous, immediately after the transaction commits — the sim cache
  // must never lag SQLite by so much as one tick, or a freshly reproduced
  // worker would be invisible until the next full reload. See simulation.ts.
  registerWorker({ id: newWorkerId, colonyId, x: colony.queenX, y: colony.queenY });
  return { ok: true };
}
