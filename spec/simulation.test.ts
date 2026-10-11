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

    // Stage 3: left as "move", this worker would drift indefinitely through
    // every later describe block — harmless pre-Stage-3 (workers never
    // affected each other), but Stage 3's separation makes a passing-by
    // worker observable to anyone it nears. Send it back home and let it
    // settle so later tests' own geometry is the only thing in play.
    expect(sim.issueMoveCommand(worker.id, start.x, start.y)).toBeNull();
    sim.advanceSimulation(TICK_DT);
    expect(workerById(worker.id)).toEqual({ id: worker.id, x: start.x, y: start.y });
    expect(sim.getWorkerCommand(worker.id)).toBe("idle");
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

// Stage 3: loose swarm movement — group destination offsets, worker-worker
// separation, and the spatial grid they run on. Fresh ids (>= 11001) and
// coordinates in quiet corners of the world, none shared with any test
// above, so this block needs no reset/reload seam of its own.
describe("Stage 3: loose swarm movement", () => {
  it("computeGroupDestinations spreads a group onto distinct destinations near the centre, within world bounds", () => {
    const ids = [11001, 11002, 11003, 11004, 11005];
    const center = { x: 2900, y: 200 };
    const destinations = sim.computeGroupDestinations(ids, center.x, center.y);

    expect(destinations.size).toBe(ids.length);
    const points = ids.map((id) => destinations.get(id)!);
    const keys = new Set(points.map((p) => `${p.x}:${p.y}`));
    expect(keys.size).toBe(ids.length);
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(world.width);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(world.height);
      expect(Math.hypot(p.x - center.x, p.y - center.y)).toBeLessThan(100);
    }
  });

  it("computeGroupDestinations returns the exact centre for a single worker, and a solo move still arrives exactly", () => {
    const center = { x: 2900, y: 200 };
    const destinations = sim.computeGroupDestinations([11006], center.x, center.y);
    expect(destinations.get(11006)).toEqual(center);

    const worker = registerTestWorker(11006, center.x - 30, center.y);
    expect(sim.issueMoveCommand(worker.id, center.x, center.y)).toBeNull();
    for (let i = 0; i < 10; i++) sim.advanceSimulation(TICK_DT);

    const after = workerById(worker.id);
    expect(after.x).toBe(center.x);
    expect(after.y).toBe(center.y);
    expect(sim.getWorkerCommand(worker.id)).toBe("idle");
  });

  it("separation moves two workers stacked on the same point apart", () => {
    const a = registerTestWorker(11007, 100, 100);
    const b = registerTestWorker(11008, 100, 100);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBe(0);

    sim.advanceSimulation(TICK_DT);

    const afterA = workerById(a.id);
    const afterB = workerById(b.id);
    expect(Math.hypot(afterA.x - afterB.x, afterA.y - afterB.y)).toBeGreaterThan(0);
  });

  it("a group move spread onto distinct destinations settles with no two workers on the exact same point", () => {
    const ids = [11009, 11010, 11011, 11012];
    for (const id of ids) registerTestWorker(id, 150, 150);
    const target = { x: 400, y: 150 };
    const destinations = sim.computeGroupDestinations(ids, target.x, target.y);
    for (const id of ids) {
      const dest = destinations.get(id)!;
      expect(sim.issueMoveCommand(id, dest.x, dest.y)).toBeNull();
    }
    for (let i = 0; i < 50; i++) sim.advanceSimulation(TICK_DT);

    const positions = ids.map((id) => workerById(id));
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        expect(positions[i].x === positions[j].x && positions[i].y === positions[j].y).toBe(false);
      }
    }
  });

  it("a worker with a close neighbour still makes net progress toward a distant target", () => {
    const mover = registerTestWorker(11013, 500, 500);
    // Idle neighbour sitting directly in the mover's path, 10 units away
    // (< MIN_SEPARATION). It isn't actually stationary — separation pushes
    // it too, so as the mover closes in the neighbour keeps retreating along
    // the same line, settling into a pursuit equilibrium where the mover's
    // net speed is roughly half of WORKER_SPEED rather than the near-full
    // speed a truly fixed obstacle would allow. 50 ticks at that half-rate
    // reproducibly lands at 879.375, well short of a naive >900 expectation
    // for unobstructed travel — the assertion only needs to confirm real
    // progress is still being made, not match unobstructed speed.
    registerTestWorker(11014, 510, 500);
    const target = { x: 1000, y: 500 };

    expect(sim.issueMoveCommand(mover.id, target.x, target.y)).toBeNull();
    for (let i = 0; i < 50; i++) sim.advanceSimulation(TICK_DT);

    expect(workerById(mover.id).x).toBeGreaterThan(800);
  });

  it("once workers are arrived and spaced apart, further ticks cause no further movement", () => {
    const a = registerTestWorker(11015, 700, 500);
    const b = registerTestWorker(11016, 750, 500); // 50 units apart, >= MIN_SEPARATION
    sim.advanceSimulation(TICK_DT);

    const afterA = workerById(a.id);
    const afterB = workerById(b.id);
    sim.advanceSimulation(TICK_DT);

    expect(workerById(a.id)).toEqual(afterA);
    expect(workerById(b.id)).toEqual(afterB);
  });

  it("separation near a world edge never pushes a worker out of bounds", () => {
    const a = registerTestWorker(11017, 5, 5);
    const b = registerTestWorker(11018, 5, 5);
    for (let i = 0; i < 10; i++) sim.advanceSimulation(TICK_DT);

    for (const w of [workerById(a.id), workerById(b.id)]) {
      expect(w.x).toBeGreaterThanOrEqual(0);
      expect(w.x).toBeLessThanOrEqual(world.width);
      expect(w.y).toBeGreaterThanOrEqual(0);
      expect(w.y).toBeLessThanOrEqual(world.height);
    }
  });

  it("gathering regression: a close-together group gathering a finite node still yields exactly one claim", () => {
    const worldRow = db.prepare("SELECT id FROM worlds LIMIT 1").get() as { id: number };
    const { lastInsertRowid: nodeId } = db
      .prepare(
        "INSERT INTO resource_nodes (world_id, x, y, resource_type, amount, max_amount) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(worldRow.id, 2000, 2800, "biomass", GATHER_YIELD, GATHER_YIELD);
    const group = [11019, 11020, 11021].map((id, i) => registerTestWorker(id, 2000 + i * 5, 2800));
    const beforeColony = resourceAmount("biomass");

    for (const w of group) expect(sim.issueGatherCommand(w.id, Number(nodeId))).toBeNull();
    sim.advanceSimulation(TICK_DT);

    expect(resourceAmount("biomass")).toBe(beforeColony + GATHER_YIELD);
    expect(nodeRow(Number(nodeId))).toBeUndefined();
    for (const w of group) expect(sim.getWorkerCommand(w.id)).toBe("idle");
  });

  it("command-override regression: redirecting one member of a moving group changes its course while the rest continue", () => {
    const ids = [11022, 11023, 11024];
    const starts = ids.map((id, i) => registerTestWorker(id, 2000, 50 + i * 2));
    const firstTarget = { x: 2500, y: 50 };

    for (const w of starts) expect(sim.issueMoveCommand(w.id, firstTarget.x, firstTarget.y)).toBeNull();
    sim.advanceSimulation(TICK_DT);

    // Baseline is taken right before the redirect, not at registration — the
    // group's own tight initial spacing (2 units, well under MIN_SEPARATION)
    // means separation visibly reshuffles everyone within that first tick,
    // same as it would for any crowd this close. What this test checks is
    // that the *second* command changes course from there, not that it
    // somehow erases that first tick's spacing adjustment.
    const beforeRedirect = workerById(starts[0].id);
    const secondTarget = { x: 2000, y: 500 };
    expect(sim.issueMoveCommand(starts[0].id, secondTarget.x, secondTarget.y)).toBeNull();
    sim.advanceSimulation(TICK_DT);

    const redirected = workerById(starts[0].id);
    expect(redirected.y).toBeGreaterThan(beforeRedirect.y);

    for (const w of starts.slice(1)) {
      expect(workerById(w.id).x).toBeGreaterThan(w.x);
    }
    expect(sim.getWorkerCommand(starts[0].id)).toBe("move");
    expect(sim.getWorkerCommand(starts[1].id)).toBe("move");
  });
});
