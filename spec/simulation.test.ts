import { existsSync, rmSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

// Stage 1b direct-module-level testability seam: this file is the one
// exception to the rest of spec/, which is strictly black-box over HTTP
// against a separately-running process. There is no way to advance
// simulation time deterministically through the production HTTP surface
// without adding a debug-only endpoint, which the brief asks us to avoid
// when direct module control is sufficient — so this file imports
// src/server/simulation.ts straight into the Vitest process instead,
// against a throwaway SQLite file that never touches the dev DB or the
// deployed volume. See CLAUDE.md.
const DB_PATH = "./.data/colony.sim-test.db";
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(DB_PATH + suffix)) rmSync(DB_PATH + suffix);
}
process.env.DB_PATH = DB_PATH;

// Dynamic imports, not static ones: DB_PATH must be set in process.env
// before db.ts's module-level `new Database(DB_PATH)` runs.
const { db } = await import("../src/server/db.ts");
const sim = await import("../src/server/simulation.ts");
const { SIMULATION, GATHER_YIELD } = await import("../src/server/balance.ts");

const TICK_DT = 1 / SIMULATION.tickHz;

const colony = db.prepare("SELECT id FROM colonies LIMIT 1").get() as { id: number };
const world = db.prepare("SELECT width, height FROM worlds LIMIT 1").get() as { width: number; height: number };

function workerById(id: number) {
  const found = sim.getWorkersForColony(colony.id).find((w) => w.id === id);
  if (!found) throw new Error(`no such worker in sim state: ${id}`);
  return found;
}

// Stage 1c gather tests register their own synthetic workers (ids well above
// the 3 seeded ones) positioned right on top of whichever node they're
// exercising — that's what lets a test force an arrival in a single tick
// instead of waiting out real travel time. These never get a `workers` SQL
// row, which is fine: nothing but checkpointSimulation() reads that table,
// and these tests never call it.
function registerTestWorker(id: number, x: number, y: number) {
  sim.registerWorker({ id, colonyId: colony.id, x, y });
  return workerById(id);
}

function resourceAmount(resourceType: string): number {
  const row = db
    .prepare("SELECT amount FROM colony_resources WHERE colony_id = ? AND resource_type = ?")
    .get(colony.id, resourceType) as { amount: number };
  return row.amount;
}

function nodeRow(id: number): { id: number; x: number; y: number; amount: number | null } | undefined {
  return db.prepare("SELECT id, x, y, amount FROM resource_nodes WHERE id = ?").get(id) as
    | { id: number; x: number; y: number; amount: number | null }
    | undefined;
}

function findNodesByType(resourceType: string): { id: number; x: number; y: number; amount: number | null }[] {
  return db.prepare("SELECT id, x, y, amount FROM resource_nodes WHERE resource_type = ? ORDER BY id").all(
    resourceType,
  ) as { id: number; x: number; y: number; amount: number | null }[];
}

beforeAll(() => {
  // A fresh throwaway DB seeds 3 workers (see db.ts) — one per test below so
  // tests don't interfere with each other's commands.
  expect(sim.getWorkersForColony(colony.id)).toHaveLength(3);
});

describe("gradual movement", () => {
  it("moves a worker toward its target by speed * dt, without teleporting", () => {
    const [worker] = sim.getWorkersForColony(colony.id);
    const start = { x: worker.x, y: worker.y };
    const target = { x: start.x + 1000, y: start.y };

    expect(sim.issueMoveCommand(worker.id, target.x, target.y)).toBeNull();
    sim.advanceSimulation(TICK_DT);

    const after = workerById(worker.id);
    expect(after.x).toBeGreaterThan(start.x);
    expect(after.x).toBeLessThan(target.x);
    expect(after.y).toBe(start.y);
    expect(sim.getWorkerCommand(worker.id)).toBe("move");
  });
});

describe("arrival", () => {
  it("reaches the destination exactly and goes idle, without overshooting", () => {
    const [, worker] = sim.getWorkersForColony(colony.id);
    const start = { x: worker.x, y: worker.y };
    const target = { x: start.x + 30, y: start.y };

    expect(sim.issueMoveCommand(worker.id, target.x, target.y)).toBeNull();
    // 30 units at WORKER_SPEED=150/s needs 0.2s; advance well past that.
    for (let i = 0; i < 10; i++) sim.advanceSimulation(TICK_DT);

    const after = workerById(worker.id);
    expect(after.x).toBe(target.x);
    expect(after.y).toBe(target.y);
    expect(sim.getWorkerCommand(worker.id)).toBe("idle");

    // Further ticks after arrival must not move an idle worker.
    sim.advanceSimulation(TICK_DT);
    expect(workerById(worker.id)).toEqual(after);
  });
});

describe("world bounds / invalid movement", () => {
  it("rejects a command for a worker that doesn't exist", () => {
    expect(sim.issueMoveCommand(999999, 100, 100)).toBe("no such worker");
  });

  it("rejects non-finite coordinates", () => {
    const [, , worker] = sim.getWorkersForColony(colony.id);
    expect(sim.issueMoveCommand(worker.id, Number.NaN, 100)).toBe("invalid coordinates");
    expect(sim.issueMoveCommand(worker.id, 100, Number.POSITIVE_INFINITY)).toBe("invalid coordinates");
  });

  it("rejects coordinates outside the world bounds", () => {
    const [, , worker] = sim.getWorkersForColony(colony.id);
    expect(sim.issueMoveCommand(worker.id, -10, 100)).toBe("coordinates out of bounds");
    expect(sim.issueMoveCommand(worker.id, world.width + 10, 100)).toBe("coordinates out of bounds");
  });
});

describe("checkpoint persistence", () => {
  it("restores the checkpointed position on reload, with commands reset to idle", () => {
    const [worker] = sim.getWorkersForColony(colony.id);
    const target = { x: worker.x + 1000, y: worker.y };

    expect(sim.issueMoveCommand(worker.id, target.x, target.y)).toBeNull();
    sim.advanceSimulation(TICK_DT); // mid-flight, not arrived
    const midFlight = workerById(worker.id);
    expect(sim.getWorkerCommand(worker.id)).toBe("move");

    sim.checkpointSimulation();
    sim.loadSimulation(); // simulates a process restart reading the checkpoint back

    const restored = workerById(worker.id);
    expect(restored.x).toBeCloseTo(midFlight.x, 6);
    expect(restored.y).toBeCloseTo(midFlight.y, 6);
    expect(sim.getWorkerCommand(worker.id)).toBe("idle");
  });
});

// Stage 1c: runs last, deliberately. loadSimulation() above already reset
// every worker to idle from a checkpoint, but these tests register their own
// synthetic workers anyway (see registerTestWorker) — placing this block
// after every other describe() means its many extra advanceSimulation calls
// (test G alone advances 200 ticks) can never finish off some *other* test's
// still-in-flight real worker out from under it, the way inserting this
// block earlier once did to the checkpoint-persistence test above.
describe("gather: travel + claim", () => {
  it("A: issuing a gather command starts travel without crediting anything instantly", () => {
    const [sugarNode] = findNodesByType("sugar");
    const worker = registerTestWorker(9001, sugarNode.x - 500, sugarNode.y);
    const before = resourceAmount("sugar");

    expect(sim.issueGatherCommand(worker.id, sugarNode.id)).toBeNull();

    expect(sim.getWorkerCommand(worker.id)).toBe("gather");
    expect(resourceAmount("sugar")).toBe(before);
  });

  it("B: arriving at an infinite node credits GATHER_YIELD and leaves its amount at null", () => {
    const [sugarNode] = findNodesByType("sugar");
    const worker = registerTestWorker(9002, sugarNode.x, sugarNode.y);
    const before = resourceAmount("sugar");

    expect(sim.issueGatherCommand(worker.id, sugarNode.id)).toBeNull();
    sim.advanceSimulation(TICK_DT);

    expect(resourceAmount("sugar")).toBe(before + GATHER_YIELD);
    expect(sim.getWorkerCommand(worker.id)).toBe("idle");
    expect(nodeRow(sugarNode.id)?.amount).toBeNull();
  });

  it("C: arriving at a finite node credits GATHER_YIELD and decrements its remaining amount", () => {
    const [proteinNode] = findNodesByType("protein");
    const worker = registerTestWorker(9003, proteinNode.x, proteinNode.y);
    const beforeColony = resourceAmount("protein");
    const beforeNode = nodeRow(proteinNode.id)!.amount!;

    expect(sim.issueGatherCommand(worker.id, proteinNode.id)).toBeNull();
    sim.advanceSimulation(TICK_DT);

    expect(resourceAmount("protein")).toBe(beforeColony + GATHER_YIELD);
    expect(nodeRow(proteinNode.id)?.amount).toBe(beforeNode - GATHER_YIELD);
  });

  it("D: a claim is capped at whatever's left, and the node is deleted once exhausted", () => {
    const [, proteinNode] = findNodesByType("protein");
    db.prepare("UPDATE resource_nodes SET amount = ? WHERE id = ?").run(4, proteinNode.id);
    const worker = registerTestWorker(9004, proteinNode.x, proteinNode.y);
    const beforeColony = resourceAmount("protein");

    expect(sim.issueGatherCommand(worker.id, proteinNode.id)).toBeNull();
    sim.advanceSimulation(TICK_DT);

    expect(resourceAmount("protein")).toBe(beforeColony + 4);
    expect(nodeRow(proteinNode.id)).toBeUndefined();
  });

  it("E: a node claimed by another worker earlier in the same tick isn't double-credited", () => {
    const [, , proteinNode] = findNodesByType("protein");
    db.prepare("UPDATE resource_nodes SET amount = ? WHERE id = ?").run(GATHER_YIELD, proteinNode.id);
    // Registered (and so processed by advanceSimulation) in this order, so
    // `first`'s claim always lands before `second` is even considered.
    const first = registerTestWorker(9005, proteinNode.x, proteinNode.y);
    const second = registerTestWorker(9006, proteinNode.x + 5, proteinNode.y);
    const beforeColony = resourceAmount("protein");

    expect(sim.issueGatherCommand(first.id, proteinNode.id)).toBeNull();
    expect(sim.issueGatherCommand(second.id, proteinNode.id)).toBeNull();
    sim.advanceSimulation(TICK_DT);

    // The node only had GATHER_YIELD left — exactly one claim can have landed.
    expect(resourceAmount("protein")).toBe(beforeColony + GATHER_YIELD);
    expect(nodeRow(proteinNode.id)).toBeUndefined();
    expect(sim.getWorkerCommand(second.id)).toBe("idle");
  });

  it("F: rejects a gather command for a worker or resource node that doesn't exist", () => {
    const [sugarNode] = findNodesByType("sugar");
    expect(sim.issueGatherCommand(999999, sugarNode.id)).toBe("no such worker");

    const worker = registerTestWorker(9007, 0, 0);
    expect(sim.issueGatherCommand(worker.id, 999999)).toBe("no such resource node");
  });

  it("G: a node that disappears mid-flight redirects the worker to its last-known position instead of crediting anything", () => {
    // Pick one of the two full-amount protein nodes the D/E tests above
    // haven't touched yet (those deplete/delete whichever nodes they pick).
    const proteinNode = findNodesByType("protein").find((n) => n.amount === 200)!;
    const worker = registerTestWorker(9008, proteinNode.x - 1000, proteinNode.y);
    const beforeColony = resourceAmount("protein");

    expect(sim.issueGatherCommand(worker.id, proteinNode.id)).toBeNull();
    sim.advanceSimulation(TICK_DT); // mid-flight, resource still exists

    db.prepare("DELETE FROM resource_nodes WHERE id = ?").run(proteinNode.id);

    for (let i = 0; i < 200; i++) sim.advanceSimulation(TICK_DT); // plenty to cover ~1000 units at WORKER_SPEED

    expect(sim.getWorkerCommand(worker.id)).toBe("idle");
    expect(resourceAmount("protein")).toBe(beforeColony);
    const after = workerById(worker.id);
    expect(after.x).toBeCloseTo(proteinNode.x, 6);
    expect(after.y).toBeCloseTo(proteinNode.y, 6);
  });
});

// Stage 2: group commands are just the same per-worker command issued to
// several ids — there is no batch-aware code in simulation.ts itself (the
// batch error contract lives in index.ts, covered in spec/colony.test.ts).
// These tests use fresh synthetic ids (>= 10001) so they can't disturb any
// test above, same reasoning as the gather block's ids >= 9001.
describe("group commands", () => {
  it("H: issuing the same move target to several workers advances all of them in one tick", () => {
    const base = { x: 1000, y: 1000 };
    const workers3 = [10001, 10002, 10003].map((id) => registerTestWorker(id, base.x, base.y + id));
    const target = { x: base.x + 1000, y: base.y };

    for (const w of workers3) expect(sim.issueMoveCommand(w.id, target.x, target.y)).toBeNull();
    sim.advanceSimulation(TICK_DT);

    for (const w of workers3) {
      const after = workerById(w.id);
      expect(after.x).toBeGreaterThan(base.x);
      expect(after.x).toBeLessThan(target.x);
      expect(sim.getWorkerCommand(w.id)).toBe("move");
    }
  });

  it("I: a second move command replaces the first — the retargeted worker changes course, others continue", () => {
    // Both start on y=2000, same as firstTarget's y, so `b`'s motion is pure
    // +x with exactly zero y drift for the whole test — a precise baseline
    // to show `a` alone changed course.
    const a = registerTestWorker(10004, 2000, 2000);
    const b = registerTestWorker(10005, 2010, 2000);
    const firstTarget = { x: 2500, y: 2000 };
    const secondTarget = { x: 2000, y: 2500 };

    expect(sim.issueMoveCommand(a.id, firstTarget.x, firstTarget.y)).toBeNull();
    expect(sim.issueMoveCommand(b.id, firstTarget.x, firstTarget.y)).toBeNull();
    sim.advanceSimulation(TICK_DT);

    // Retarget `a` mid-flight before it arrives; `b` keeps heading to firstTarget.
    expect(sim.issueMoveCommand(a.id, secondTarget.x, secondTarget.y)).toBeNull();
    sim.advanceSimulation(TICK_DT);

    const afterA = workerById(a.id);
    const afterB = workerById(b.id);
    // `a` moved toward secondTarget (y increased), not firstTarget (x increased further).
    expect(afterA.y).toBeGreaterThan(2000);
    expect(afterB.x).toBeGreaterThan(2010);
    expect(afterB.y).toBe(2000);
  });

  it("J: several workers converging on an infinite node are each credited independently, no contention", () => {
    const [sugarNode] = findNodesByType("sugar");
    const group = [10006, 10007, 10008].map((id) => registerTestWorker(id, sugarNode.x, sugarNode.y));
    const before = resourceAmount("sugar");

    for (const w of group) expect(sim.issueGatherCommand(w.id, sugarNode.id)).toBeNull();
    sim.advanceSimulation(TICK_DT);

    expect(resourceAmount("sugar")).toBe(before + GATHER_YIELD * group.length);
    for (const w of group) expect(sim.getWorkerCommand(w.id)).toBe("idle");
  });

  it("K: a group gathering a finite node credits exactly one claim, the rest demote with no extra credit", () => {
    // By this point C/D/E/G above have consumed or depleted the other three
    // seeded protein nodes — whichever one is left is fine; its own amount
    // is overwritten below regardless of what it currently holds.
    const [proteinNode] = findNodesByType("protein");
    db.prepare("UPDATE resource_nodes SET amount = ? WHERE id = ?").run(GATHER_YIELD, proteinNode.id);
    const group = [10009, 10010, 10011].map((id, i) =>
      registerTestWorker(id, proteinNode.x + i * 5, proteinNode.y),
    );
    const beforeColony = resourceAmount("protein");

    for (const w of group) expect(sim.issueGatherCommand(w.id, proteinNode.id)).toBeNull();
    sim.advanceSimulation(TICK_DT);

    // The node only had GATHER_YIELD left — exactly one claim can have landed.
    expect(resourceAmount("protein")).toBe(beforeColony + GATHER_YIELD);
    expect(nodeRow(proteinNode.id)).toBeUndefined();
    for (const w of group) expect(sim.getWorkerCommand(w.id)).toBe("idle");
  });
});
