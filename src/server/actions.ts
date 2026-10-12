import { REPRODUCE_COST, WORKER_MAX_HEALTH } from "./balance.ts";
import { db } from "./db.ts";
import { registerWorker } from "./simulation.ts";

export type ActionResult = { ok: true } | { ok: false; error: string };

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
      .prepare("INSERT INTO workers (colony_id, x, y, health, max_health) VALUES (?, ?, ?, ?, ?)")
      .run(colonyId, colony.queenX, colony.queenY, WORKER_MAX_HEALTH, WORKER_MAX_HEALTH);
    newWorkerId = Number(info.lastInsertRowid);
  });
  tx();
  // Synchronous, immediately after the transaction commits — the sim cache
  // must never lag SQLite by so much as one tick, or a freshly reproduced
  // worker would be invisible until the next full reload. See simulation.ts.
  registerWorker({
    id: newWorkerId,
    colonyId,
    x: colony.queenX,
    y: colony.queenY,
    health: WORKER_MAX_HEALTH,
    maxHealth: WORKER_MAX_HEALTH,
  });
  return { ok: true };
}
