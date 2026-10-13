import { REPRODUCE_COST, WORKER_MAX_HEALTH } from "./balance.ts";
import { db } from "./db.ts";
import { defeatColony, isColonyActive, registerWorker } from "./simulation.ts";

export type ActionResult = { ok: true } | { ok: false; error: string };

export function reproduce(colonyId: number): ActionResult {
  // Stage 8: a defeated colony has no queen left to reproduce from — checked
  // by lifecycle status itself, not incidentally via "no colony_resources
  // row" (the row is deleted on defeat, but that's not what's being tested
  // here; see §23).
  if (!isColonyActive(colonyId)) return { ok: false, error: "colony defeated" };

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

// Stage 8: the manual, player-initiated counterpart to a lethal spider hit.
// Deliberately calls the exact same authoritative defeatColony() transaction
// a queen's death uses — no second reset system (§20) — differing only in
// the cause recorded. Does NOT require the player to have a worker or any
// resources: a colony soft-locked at zero workers/protein must still be
// abandonable, which is the entire point of this feature (§36).
export function abandon(colonyId: number): ActionResult {
  if (!isColonyActive(colonyId)) return { ok: false, error: "colony already defeated" };
  defeatColony(colonyId, "abandoned");
  return { ok: true };
}
