import { existsSync, rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

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
const { db, resetForTests } = await import("../src/server/db.ts");
const sim = await import("../src/server/simulation.ts");
const actions = await import("../src/server/actions.ts");
const {
  SIMULATION,
  GATHER_YIELD,
  REPRODUCE_COST,
  SUGAR_NODE_MAX_AMOUNT,
  SUGAR_REGEN_RATE,
  BIOMASS_REGEN_RATE,
  APHID_SEED_POSITIONS,
  APHID_IDLE_MAX,
  APHID_MAX_HEALTH,
  APHID_PROTEIN_VALUE,
  WORKER_ATTACK_RANGE,
  WORKER_ATTACK_DAMAGE,
  WORKER_ATTACK_COOLDOWN,
} = await import("../src/server/balance.ts");

const TICK_DT = 1 / SIMULATION.tickHz;

const colony = db.prepare("SELECT id FROM colonies LIMIT 1").get() as { id: number };
const world = db.prepare("SELECT id, width, height FROM worlds LIMIT 1").get() as {
  id: number;
  width: number;
  height: number;
};

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

function fullNodeRow(
  id: number,
): { id: number; resourceType: string; amount: number | null; maxAmount: number | null; kind: string } | undefined {
  return db
    .prepare(
      "SELECT id, resource_type AS resourceType, amount, max_amount AS maxAmount, kind FROM resource_nodes WHERE id = ?",
    )
    .get(id) as
    | { id: number; resourceType: string; amount: number | null; maxAmount: number | null; kind: string }
    | undefined;
}

function findNodesByType(resourceType: string): { id: number; x: number; y: number; amount: number | null }[] {
  return db.prepare("SELECT id, x, y, amount FROM resource_nodes WHERE resource_type = ? ORDER BY id").all(
    resourceType,
  ) as { id: number; x: number; y: number; amount: number | null }[];
}

function queenPosition(): { x: number; y: number } {
  return db.prepare("SELECT queen_x AS x, queen_y AS y FROM colonies WHERE id = ?").get(colony.id) as {
    x: number;
    y: number;
  };
}

function insertNode(x: number, y: number, resourceType: string, amount: number | null): number {
  const worldRow = db.prepare("SELECT id FROM worlds LIMIT 1").get() as { id: number };
  const { lastInsertRowid } = db
    .prepare("INSERT INTO resource_nodes (world_id, x, y, resource_type, amount, max_amount) VALUES (?, ?, ?, ?, ?, ?)")
    .run(worldRow.id, x, y, resourceType, amount, amount);
  return Number(lastInsertRowid);
}

function creatureById(id: number) {
  const found = sim.getCreaturesForWorld(world.id).find((c) => c.id === id);
  if (!found) throw new Error(`no such creature in sim state: ${id}`);
  return found;
}

// Directly mutates durable health then reloads so the in-memory creatures Map
// picks it up — loadSimulation() is the only way to refresh that cache. Must
// be called before registerTestWorker() in a test, never after: a synthetic
// worker only exists in-memory and loadSimulation() would silently erase it
// (see Stage 4's note in CLAUDE.md).
function setCreatureHealth(id: number, health: number): void {
  db.prepare("UPDATE creatures SET health = ? WHERE id = ?").run(health, id);
  sim.loadSimulation();
}

// Inserts a creature row directly (for tests that need two creatures at
// specific, controlled positions rather than relying on seeded aphid
// geometry). Same ordering caveat as setCreatureHealth: call before
// registering any synthetic test workers.
function insertCreature(x: number, y: number, health = APHID_MAX_HEALTH): number {
  const { lastInsertRowid } = db
    .prepare("INSERT INTO creatures (world_id, species, x, y, health, max_health) VALUES (?, 'aphid', ?, ?, ?, ?)")
    .run(world.id, x, y, health, health);
  return Number(lastInsertRowid);
}

// Stage 4 test-isolation seam: every test starts from the exact same fresh
// seed (world=1, colony=1, workers=1/2/3, resource_nodes=1..12 — see
// resetForTests in db.ts), so no test can see another's leftover commands,
// claims, or depleted nodes. This replaces the old convention of giving each
// test its own non-overlapping synthetic worker/node id range as the primary
// isolation mechanism; that convention is kept where it already exists
// (harmless) but nothing below relies on it anymore. See CLAUDE.md.
beforeEach(() => {
  resetForTests();
  sim.loadSimulation();
});

describe("gradual movement", () => {
  it("moves a worker toward its target by speed * dt, without teleporting", () => {
    const [worker] = sim.getWorkersForColony(colony.id);
    const start = { x: worker.x, y: worker.y };
    const target = { x: start.x + 1000, y: start.y };

    expect(sim.issueMoveCommand(worker.id, target.x, target.y, colony.id)).toBeNull();
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
    expect(sim.issueMoveCommand(worker.id, start.x, start.y, colony.id)).toBeNull();
    sim.advanceSimulation(TICK_DT);
    expect(workerById(worker.id)).toEqual({ id: worker.id, x: start.x, y: start.y, carrying: null });
    expect(sim.getWorkerCommand(worker.id)).toBe("idle");
  });
});

describe("arrival", () => {
  it("reaches the destination exactly and goes idle, without overshooting", () => {
    const [, worker] = sim.getWorkersForColony(colony.id);
    const start = { x: worker.x, y: worker.y };
    const target = { x: start.x + 30, y: start.y };

    expect(sim.issueMoveCommand(worker.id, target.x, target.y, colony.id)).toBeNull();
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
    expect(sim.issueMoveCommand(999999, 100, 100, colony.id)).toBe("no such worker");
  });

  it("rejects non-finite coordinates", () => {
    const [, , worker] = sim.getWorkersForColony(colony.id);
    expect(sim.issueMoveCommand(worker.id, Number.NaN, 100, colony.id)).toBe("invalid coordinates");
    expect(sim.issueMoveCommand(worker.id, 100, Number.POSITIVE_INFINITY, colony.id)).toBe("invalid coordinates");
  });

  it("rejects coordinates outside the world bounds", () => {
    const [, , worker] = sim.getWorkersForColony(colony.id);
    expect(sim.issueMoveCommand(worker.id, -10, 100, colony.id)).toBe("coordinates out of bounds");
    expect(sim.issueMoveCommand(worker.id, world.width + 10, 100, colony.id)).toBe("coordinates out of bounds");
  });
});

describe("checkpoint persistence", () => {
  it("restores the checkpointed position on reload, with commands reset to idle", () => {
    const [worker] = sim.getWorkersForColony(colony.id);
    const target = { x: worker.x + 1000, y: worker.y };

    expect(sim.issueMoveCommand(worker.id, target.x, target.y, colony.id)).toBeNull();
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

// Stage 1c, extended by Stage 4: a successful claim no longer credits the
// colony directly — it picks the payload up into worker.carrying and sends
// the worker home (see simulation.ts's attemptGatherClaim/attemptDeposit).
// These tests register their own synthetic workers (see registerTestWorker)
// positioned right on top of whichever node they're exercising, which is
// what lets a test force an arrival in a single tick instead of waiting out
// real travel time.
describe("gather: travel + claim", () => {
  it("A: issuing a gather command starts travel without crediting anything instantly", () => {
    const [sugarNode] = findNodesByType("sugar");
    const worker = registerTestWorker(9001, sugarNode.x - 500, sugarNode.y);
    const before = resourceAmount("sugar");

    expect(sim.issueGatherCommand(worker.id, sugarNode.id, colony.id)).toBeNull();

    expect(sim.getWorkerCommand(worker.id)).toBe("gather");
    expect(resourceAmount("sugar")).toBe(before);
  });

  it("B: arriving at a renewable node claims GATHER_YIELD into carrying without crediting the colony, and decrements its amount", () => {
    const [sugarNode] = findNodesByType("sugar");
    const beforeNodeAmount = nodeRow(sugarNode.id)!.amount!;
    const worker = registerTestWorker(9002, sugarNode.x, sugarNode.y);
    const before = resourceAmount("sugar");

    expect(sim.issueGatherCommand(worker.id, sugarNode.id, colony.id)).toBeNull();
    sim.advanceSimulation(TICK_DT);

    expect(resourceAmount("sugar")).toBe(before); // not credited yet — only deposit credits the colony
    expect(workerById(worker.id).carrying).toEqual({ resourceType: "sugar", amount: GATHER_YIELD });
    expect(sim.getWorkerCommand(worker.id)).toBe("return"); // auto-issued, no client command involved
    // Stage 5: sugar is now finite + renewable, same as biomass — a claim
    // depletes it like any finite node (see "Stage 5: renewable resource
    // regeneration" below for the regeneration half of that behaviour).
    expect(nodeRow(sugarNode.id)?.amount).toBe(beforeNodeAmount - GATHER_YIELD);
  });

  it("C: arriving at a finite node claims GATHER_YIELD into carrying, decrements the node, and still doesn't credit the colony", () => {
    const [proteinNode] = findNodesByType("protein");
    const worker = registerTestWorker(9003, proteinNode.x, proteinNode.y);
    const beforeColony = resourceAmount("protein");
    const beforeNode = nodeRow(proteinNode.id)!.amount!;

    expect(sim.issueGatherCommand(worker.id, proteinNode.id, colony.id)).toBeNull();
    sim.advanceSimulation(TICK_DT);

    expect(resourceAmount("protein")).toBe(beforeColony); // not credited until deposit
    expect(workerById(worker.id).carrying).toEqual({ resourceType: "protein", amount: GATHER_YIELD });
    expect(sim.getWorkerCommand(worker.id)).toBe("return");
    expect(nodeRow(proteinNode.id)?.amount).toBe(beforeNode - GATHER_YIELD);
  });

  it("D: a claim is capped at whatever's left, and the node is deleted once exhausted", () => {
    const [, proteinNode] = findNodesByType("protein");
    db.prepare("UPDATE resource_nodes SET amount = ? WHERE id = ?").run(4, proteinNode.id);
    const worker = registerTestWorker(9004, proteinNode.x, proteinNode.y);
    const beforeColony = resourceAmount("protein");

    expect(sim.issueGatherCommand(worker.id, proteinNode.id, colony.id)).toBeNull();
    sim.advanceSimulation(TICK_DT);

    expect(resourceAmount("protein")).toBe(beforeColony); // still not credited
    expect(workerById(worker.id).carrying).toEqual({ resourceType: "protein", amount: 4 }); // capped, not the full GATHER_YIELD
    expect(sim.getWorkerCommand(worker.id)).toBe("return");
    expect(nodeRow(proteinNode.id)).toBeUndefined();
  });

  it("E: a node claimed by another worker earlier in the same tick isn't double-claimed", () => {
    const [, , proteinNode] = findNodesByType("protein");
    db.prepare("UPDATE resource_nodes SET amount = ? WHERE id = ?").run(GATHER_YIELD, proteinNode.id);
    // Registered (and so processed by advanceSimulation) in this order, so
    // `first`'s claim always lands before `second` is even considered.
    const first = registerTestWorker(9005, proteinNode.x, proteinNode.y);
    const second = registerTestWorker(9006, proteinNode.x + 5, proteinNode.y);
    const beforeColony = resourceAmount("protein");

    expect(sim.issueGatherCommand(first.id, proteinNode.id, colony.id)).toBeNull();
    expect(sim.issueGatherCommand(second.id, proteinNode.id, colony.id)).toBeNull();
    sim.advanceSimulation(TICK_DT);

    // The node only had GATHER_YIELD left — exactly one claim can have landed.
    expect(resourceAmount("protein")).toBe(beforeColony);
    expect(workerById(first.id).carrying).toEqual({ resourceType: "protein", amount: GATHER_YIELD });
    expect(sim.getWorkerCommand(first.id)).toBe("return");
    expect(workerById(second.id).carrying).toBeNull();
    expect(nodeRow(proteinNode.id)).toBeUndefined();
    expect(sim.getWorkerCommand(second.id)).toBe("idle");
  });

  it("F: rejects a gather command for a worker or resource node that doesn't exist", () => {
    const [sugarNode] = findNodesByType("sugar");
    expect(sim.issueGatherCommand(999999, sugarNode.id, colony.id)).toBe("no such worker");

    const worker = registerTestWorker(9007, 0, 0);
    expect(sim.issueGatherCommand(worker.id, 999999, colony.id)).toBe("no such resource node");
  });

  it("G: a node that disappears mid-flight redirects the worker to its last-known position instead of crediting anything", () => {
    const [proteinNode] = findNodesByType("protein");
    const worker = registerTestWorker(9008, proteinNode.x - 1000, proteinNode.y);
    const beforeColony = resourceAmount("protein");

    expect(sim.issueGatherCommand(worker.id, proteinNode.id, colony.id)).toBeNull();
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
describe("group commands", () => {
  it("H: issuing the same move target to several workers advances all of them in one tick", () => {
    const base = { x: 1000, y: 1000 };
    const workers3 = [10001, 10002, 10003].map((id) => registerTestWorker(id, base.x, base.y + id));
    const target = { x: base.x + 1000, y: base.y };

    for (const w of workers3) expect(sim.issueMoveCommand(w.id, target.x, target.y, colony.id)).toBeNull();
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

    expect(sim.issueMoveCommand(a.id, firstTarget.x, firstTarget.y, colony.id)).toBeNull();
    expect(sim.issueMoveCommand(b.id, firstTarget.x, firstTarget.y, colony.id)).toBeNull();
    sim.advanceSimulation(TICK_DT);

    // Retarget `a` mid-flight before it arrives; `b` keeps heading to firstTarget.
    expect(sim.issueMoveCommand(a.id, secondTarget.x, secondTarget.y, colony.id)).toBeNull();
    sim.advanceSimulation(TICK_DT);

    const afterA = workerById(a.id);
    const afterB = workerById(b.id);
    // `a` moved toward secondTarget (y increased), not firstTarget (x increased further).
    expect(afterA.y).toBeGreaterThan(2000);
    expect(afterB.x).toBeGreaterThan(2010);
    expect(afterB.y).toBe(2000);
  });

  it("J: several workers converging on a renewable node each claim a payload independently, no contention", () => {
    const [sugarNode] = findNodesByType("sugar");
    const beforeNodeAmount = nodeRow(sugarNode.id)!.amount!;
    const group = [10006, 10007, 10008].map((id) => registerTestWorker(id, sugarNode.x, sugarNode.y));
    const before = resourceAmount("sugar");

    for (const w of group) expect(sim.issueGatherCommand(w.id, sugarNode.id, colony.id)).toBeNull();
    sim.advanceSimulation(TICK_DT);

    // Claiming doesn't credit the colony — each worker is now carrying its
    // own payload home instead.
    expect(resourceAmount("sugar")).toBe(before);
    for (const w of group) {
      expect(workerById(w.id).carrying).toEqual({ resourceType: "sugar", amount: GATHER_YIELD });
      expect(sim.getWorkerCommand(w.id)).toBe("return");
    }
    // Stage 5: each claim independently decrements the shared renewable
    // node — no contention, same as it would for a finite biomass node.
    expect(nodeRow(sugarNode.id)?.amount).toBe(beforeNodeAmount - 3 * GATHER_YIELD);
  });

  it("K: a group gathering a finite node lets exactly one claim land, the rest demote with no carrying", () => {
    // By this point C/D/E/G above have consumed or depleted the other three
    // seeded protein nodes — whichever one is left is fine; its own amount
    // is overwritten below regardless of what it currently holds.
    const [proteinNode] = findNodesByType("protein");
    db.prepare("UPDATE resource_nodes SET amount = ? WHERE id = ?").run(GATHER_YIELD, proteinNode.id);
    const group = [10009, 10010, 10011].map((id, i) =>
      registerTestWorker(id, proteinNode.x + i * 5, proteinNode.y),
    );
    const beforeColony = resourceAmount("protein");

    for (const w of group) expect(sim.issueGatherCommand(w.id, proteinNode.id, colony.id)).toBeNull();
    sim.advanceSimulation(TICK_DT);

    // The node only had GATHER_YIELD left — exactly one claim can have
    // landed, and even that claim doesn't credit the colony yet.
    expect(resourceAmount("protein")).toBe(beforeColony);
    expect(nodeRow(proteinNode.id)).toBeUndefined();
    const carrying = group.map((w) => workerById(w.id).carrying);
    expect(carrying.filter((c) => c !== null)).toEqual([{ resourceType: "protein", amount: GATHER_YIELD }]);
    for (const w of group) {
      expect(sim.getWorkerCommand(w.id)).toBe(workerById(w.id).carrying ? "return" : "idle");
    }
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
    expect(sim.issueMoveCommand(worker.id, center.x, center.y, colony.id)).toBeNull();
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
      expect(sim.issueMoveCommand(id, dest.x, dest.y, colony.id)).toBeNull();
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

    expect(sim.issueMoveCommand(mover.id, target.x, target.y, colony.id)).toBeNull();
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
    const nodeId = insertNode(2000, 2800, "biomass", GATHER_YIELD);
    const group = [11019, 11020, 11021].map((id, i) => registerTestWorker(id, 2000 + i * 5, 2800));
    const beforeColony = resourceAmount("biomass");

    for (const w of group) expect(sim.issueGatherCommand(w.id, nodeId, colony.id)).toBeNull();
    sim.advanceSimulation(TICK_DT);

    // Exactly one claim can have landed — and even that claim doesn't credit
    // the colony yet, it's carried home first.
    expect(resourceAmount("biomass")).toBe(beforeColony);
    // Stage 5: biomass is renewable, so the now-empty node persists at 0
    // instead of being deleted (contrast with protein's delete-on-depletion,
    // exercised elsewhere).
    expect(nodeRow(nodeId)?.amount).toBe(0);
    const carrying = group.map((w) => workerById(w.id).carrying);
    expect(carrying.filter((c) => c !== null)).toEqual([{ resourceType: "biomass", amount: GATHER_YIELD }]);
    for (const w of group) {
      expect(sim.getWorkerCommand(w.id)).toBe(workerById(w.id).carrying ? "return" : "idle");
    }
  });

  it("command-override regression: redirecting one member of a moving group changes its course while the rest continue", () => {
    const ids = [11022, 11023, 11024];
    const starts = ids.map((id, i) => registerTestWorker(id, 2000, 50 + i * 2));
    const firstTarget = { x: 2500, y: 50 };

    for (const w of starts) expect(sim.issueMoveCommand(w.id, firstTarget.x, firstTarget.y, colony.id)).toBeNull();
    sim.advanceSimulation(TICK_DT);

    // Baseline is taken right before the redirect, not at registration — the
    // group's own tight initial spacing (2 units, well under MIN_SEPARATION)
    // means separation visibly reshuffles everyone within that first tick,
    // same as it would for any crowd this close. What this test checks is
    // that the *second* command changes course from there, not that it
    // somehow erases that first tick's spacing adjustment.
    const beforeRedirect = workerById(starts[0].id);
    const secondTarget = { x: 2000, y: 500 };
    expect(sim.issueMoveCommand(starts[0].id, secondTarget.x, secondTarget.y, colony.id)).toBeNull();
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

describe("Stage 4: carry, return, deposit economy", () => {
  it("multiple workers claim independently from a finite node with enough for all of them", () => {
    const [proteinNode] = findNodesByType("protein");
    db.prepare("UPDATE resource_nodes SET amount = ? WHERE id = ?").run(GATHER_YIELD * 3, proteinNode.id);
    const group = [9102, 9103, 9104].map((id, i) => registerTestWorker(id, proteinNode.x + i * 5, proteinNode.y));

    for (const w of group) expect(sim.issueGatherCommand(w.id, proteinNode.id, colony.id)).toBeNull();
    sim.advanceSimulation(TICK_DT);

    for (const w of group) {
      expect(workerById(w.id).carrying).toEqual({ resourceType: "protein", amount: GATHER_YIELD });
      expect(sim.getWorkerCommand(w.id)).toBe("return");
    }
    expect(nodeRow(proteinNode.id)).toBeUndefined();
    expect(resourceAmount("protein")).toBe(0); // fresh colony, and none credited yet anyway
  });

  it("a claim within deposit range of the queen still takes a second tick to deposit", () => {
    const queen = queenPosition();
    const nodeId = insertNode(queen.x + 20, queen.y, "sugar", null);
    const worker = registerTestWorker(9105, queen.x + 20, queen.y);
    const beforeColony = resourceAmount("sugar");

    expect(sim.issueGatherCommand(worker.id, nodeId, colony.id)).toBeNull();
    sim.advanceSimulation(TICK_DT); // claim resolves: carrying set, command becomes "return"

    expect(workerById(worker.id).carrying).toEqual({ resourceType: "sugar", amount: GATHER_YIELD });
    expect(sim.getWorkerCommand(worker.id)).toBe("return");
    expect(resourceAmount("sugar")).toBe(beforeColony); // not yet deposited, even though within DEPOSIT_RANGE

    sim.advanceSimulation(TICK_DT); // already in range -> deposits

    expect(resourceAmount("sugar")).toBe(beforeColony + GATHER_YIELD);
    expect(workerById(worker.id).carrying).toBeNull();
    expect(sim.getWorkerCommand(worker.id)).toBe("idle");
  });

  it("carrying survives a reload with no checkpoint call, and the worker automatically resumes returning", () => {
    const [worker] = sim.getWorkersForColony(colony.id);
    const [proteinNode] = findNodesByType("protein");
    sim.registerWorker({ id: worker.id, colonyId: colony.id, x: proteinNode.x, y: proteinNode.y });
    expect(sim.issueGatherCommand(worker.id, proteinNode.id, colony.id)).toBeNull();
    sim.advanceSimulation(TICK_DT);

    const carryingBefore = workerById(worker.id).carrying;
    expect(carryingBefore).toEqual({ resourceType: "protein", amount: GATHER_YIELD });

    sim.loadSimulation(); // no checkpointSimulation() call — proves claim-time durability alone is enough

    const restored = workerById(worker.id);
    expect(restored.carrying).toEqual(carryingBefore);
    expect(sim.getWorkerCommand(worker.id)).toBe("return");
  });

  it("a completed deposit stays complete across a reload — no double-credit", () => {
    const [worker] = sim.getWorkersForColony(colony.id);
    const queen = queenPosition();
    const nodeId = insertNode(queen.x + 20, queen.y, "sugar", null);
    sim.registerWorker({ id: worker.id, colonyId: colony.id, x: queen.x + 20, y: queen.y });

    expect(sim.issueGatherCommand(worker.id, nodeId, colony.id)).toBeNull();
    sim.advanceSimulation(TICK_DT); // claim -> carrying, command "return"
    sim.advanceSimulation(TICK_DT); // already in deposit range -> deposits

    const creditedAmount = resourceAmount("sugar");
    expect(creditedAmount).toBeGreaterThan(0);
    expect(workerById(worker.id).carrying).toBeNull();
    expect(sim.getWorkerCommand(worker.id)).toBe("idle");

    sim.loadSimulation();

    expect(resourceAmount("sugar")).toBe(creditedAmount); // the deposit's carrying-clear was already durable
    expect(workerById(worker.id).carrying).toBeNull();
    expect(sim.getWorkerCommand(worker.id)).toBe("idle");
  });

  it("carried-but-undeposited protein can't be spent on reproduction", () => {
    db.prepare("UPDATE colony_resources SET amount = ? WHERE colony_id = ? AND resource_type = 'protein'").run(
      REPRODUCE_COST - GATHER_YIELD,
      colony.id,
    );
    const [proteinNode] = findNodesByType("protein");
    const worker = registerTestWorker(9100, proteinNode.x, proteinNode.y);
    expect(sim.issueGatherCommand(worker.id, proteinNode.id, colony.id)).toBeNull();
    sim.advanceSimulation(TICK_DT);
    expect(workerById(worker.id).carrying).toEqual({ resourceType: "protein", amount: GATHER_YIELD });

    expect(actions.reproduce(colony.id)).toEqual({ ok: false, error: "not enough protein" });
  });

  it("a carrying worker rejects move and gather commands, leaving its state unchanged", () => {
    const [sugarNode] = findNodesByType("sugar");
    const worker = registerTestWorker(9101, sugarNode.x, sugarNode.y);
    expect(sim.issueGatherCommand(worker.id, sugarNode.id, colony.id)).toBeNull();
    sim.advanceSimulation(TICK_DT);
    const carryingState = workerById(worker.id);
    expect(carryingState.carrying).toEqual({ resourceType: "sugar", amount: GATHER_YIELD });

    expect(sim.issueMoveCommand(worker.id, 0, 0, colony.id)).toBe("worker is busy returning resources");
    expect(sim.issueGatherCommand(worker.id, sugarNode.id, colony.id)).toBe("worker is busy returning resources");
    expect(sim.getWorkerCommand(worker.id)).toBe("return");
    expect(workerById(worker.id)).toEqual(carryingState);
  });
});

describe("Stage 5: renewable resource regeneration", () => {
  it("A: a depleted sugar node regenerates over time", () => {
    const [sugarNode] = findNodesByType("sugar");
    db.prepare("UPDATE resource_nodes SET amount = ? WHERE id = ?").run(10, sugarNode.id);

    sim.advanceSimulation(10);

    expect(fullNodeRow(sugarNode.id)?.amount).toBe(10 + SUGAR_REGEN_RATE * 10);
  });

  it("B: a depleted biomass node regenerates over time", () => {
    const [biomassNode] = findNodesByType("biomass");
    db.prepare("UPDATE resource_nodes SET amount = ? WHERE id = ?").run(100, biomassNode.id);

    sim.advanceSimulation(10);

    expect(fullNodeRow(biomassNode.id)?.amount).toBe(100 + BIOMASS_REGEN_RATE * 10);
  });

  it("regeneration never exceeds a node's maxAmount, however large the dt", () => {
    const [sugarNode] = findNodesByType("sugar");
    db.prepare("UPDATE resource_nodes SET amount = ? WHERE id = ?").run(1, sugarNode.id);

    sim.advanceSimulation(1000); // comfortably enough to overshoot maxAmount if the cap were missing

    expect(fullNodeRow(sugarNode.id)?.amount).toBe(SUGAR_NODE_MAX_AMOUNT);
  });

  it("C: protein does not regenerate", () => {
    const [proteinNode] = findNodesByType("protein");
    const depleted = fullNodeRow(proteinNode.id)!.amount! - 50;
    db.prepare("UPDATE resource_nodes SET amount = ? WHERE id = ?").run(depleted, proteinNode.id);

    sim.advanceSimulation(1000);

    expect(fullNodeRow(proteinNode.id)?.amount).toBe(depleted);
  });

  it("D: a renewable node driven to exactly zero persists (not deleted) and later regenerates above zero", () => {
    const [sugarNode] = findNodesByType("sugar");
    db.prepare("UPDATE resource_nodes SET amount = ? WHERE id = ?").run(1, sugarNode.id);
    const worker = registerTestWorker(9200, sugarNode.x, sugarNode.y);

    expect(sim.issueGatherCommand(worker.id, sugarNode.id, colony.id)).toBeNull();
    sim.advanceSimulation(TICK_DT); // regen (node still below GATHER_YIELD) then claim drains it exactly to 0

    expect(fullNodeRow(sugarNode.id)?.amount).toBe(0);

    sim.advanceSimulation(10);

    expect(fullNodeRow(sugarNode.id)!.amount!).toBeGreaterThan(0);
  });
});

describe("Stage 5: aphid seed + wandering", () => {
  it("E: aphids seed deterministically and the same population survives a reset", () => {
    const creatures = sim.getCreaturesForWorld(world.id);
    expect(creatures).toHaveLength(APHID_SEED_POSITIONS.length);
    for (const c of creatures) {
      expect(c.species).toBe("aphid");
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.x).toBeLessThanOrEqual(world.width);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeLessThanOrEqual(world.height);
    }

    resetForTests();
    sim.loadSimulation();

    expect(sim.getCreaturesForWorld(world.id)).toEqual(creatures);
  });

  it("F: an aphid moves toward its wander target over time, staying within world bounds throughout", () => {
    const [creature] = sim.getCreaturesForWorld(world.id);
    const start = { x: creature.x, y: creature.y };

    let moved = false;
    const ticks = Math.ceil((APHID_IDLE_MAX + 10) / TICK_DT);
    for (let i = 0; i < ticks; i++) {
      sim.advanceSimulation(TICK_DT);
      const current = sim.getCreaturesForWorld(world.id).find((c) => c.id === creature.id)!;
      expect(current.x).toBeGreaterThanOrEqual(0);
      expect(current.x).toBeLessThanOrEqual(world.width);
      expect(current.y).toBeGreaterThanOrEqual(0);
      expect(current.y).toBeLessThanOrEqual(world.height);
      if (current.x !== start.x || current.y !== start.y) moved = true;
    }

    expect(moved).toBe(true);
  });

  it("G: aphid position persists across a checkpoint + reload, and wandering resumes afterward", () => {
    const [creature] = sim.getCreaturesForWorld(world.id);

    for (let i = 0; i < 20; i++) sim.advanceSimulation(TICK_DT); // partway through a wander leg
    const beforeReload = sim.getCreaturesForWorld(world.id).find((c) => c.id === creature.id)!;

    sim.checkpointSimulation();
    sim.loadSimulation(); // simulates a restart

    const afterReload = sim.getCreaturesForWorld(world.id).find((c) => c.id === creature.id)!;
    expect(afterReload.id).toBe(creature.id);
    expect(afterReload.x).toBeCloseTo(beforeReload.x, 6);
    expect(afterReload.y).toBeCloseTo(beforeReload.y, 6);

    let moved = false;
    const ticks = Math.ceil((APHID_IDLE_MAX + 10) / TICK_DT);
    for (let i = 0; i < ticks; i++) {
      sim.advanceSimulation(TICK_DT);
      const current = sim.getCreaturesForWorld(world.id).find((c) => c.id === creature.id)!;
      if (current.x !== afterReload.x || current.y !== afterReload.y) moved = true;
    }
    expect(moved).toBe(true);
  });
});

describe("Stage 6: hunting, combat, carcasses", () => {
  it("A: issueAttackCommand validates the worker and the creature independently", () => {
    const [creature] = sim.getCreaturesForWorld(world.id);
    const worker = registerTestWorker(13001, creature.x, creature.y);

    expect(sim.issueAttackCommand(999999, creature.id, colony.id)).toBe("no such worker");
    expect(sim.issueAttackCommand(worker.id, 999999, colony.id)).toBe("no such creature");
    expect(sim.issueAttackCommand(worker.id, creature.id, colony.id)).toBeNull();
    expect(sim.getWorkerCommand(worker.id)).toBe("attack");
  });

  it("B: a carrying worker rejects an attack command and keeps returning", () => {
    const [sugarNode] = findNodesByType("sugar");
    const worker = registerTestWorker(13002, sugarNode.x, sugarNode.y);
    expect(sim.issueGatherCommand(worker.id, sugarNode.id, colony.id)).toBeNull();
    sim.advanceSimulation(TICK_DT);
    expect(workerById(worker.id).carrying).not.toBeNull();

    const [creature] = sim.getCreaturesForWorld(world.id);
    expect(sim.issueAttackCommand(worker.id, creature.id, colony.id)).toBe("worker is busy returning resources");
    expect(sim.getWorkerCommand(worker.id)).toBe("return");
  });

  it("C: chases the creature's live position every tick, not where it was when the command was issued", () => {
    const [creature] = sim.getCreaturesForWorld(world.id);
    const startX = creature.x;
    const startY = creature.y;
    const worker = registerTestWorker(13003, creature.x + 2000, creature.y);
    expect(sim.issueAttackCommand(worker.id, creature.id, colony.id)).toBeNull();

    // Stop as soon as the worker first reaches attack range, rather than
    // running a fixed number of ticks — once in range, cooldown-gated hits
    // start landing and a long-enough fixed loop would let the (only 30 HP)
    // aphid die before we ever assert on it.
    let inRange = false;
    for (let i = 0; i < 300 && !inRange; i++) {
      sim.advanceSimulation(TICK_DT);
      const live = creatureById(creature.id);
      const w = workerById(worker.id);
      inRange = Math.hypot(w.x - live.x, w.y - live.y) <= WORKER_ATTACK_RANGE + 1e-6;
    }
    expect(inRange).toBe(true);

    const liveCreature = creatureById(creature.id);
    const after = workerById(worker.id);
    const dist = Math.hypot(after.x - liveCreature.x, after.y - liveCreature.y);
    expect(dist).toBeLessThanOrEqual(WORKER_ATTACK_RANGE + 1e-6);
    // The aphid actually moved from its start — otherwise this would pass
    // trivially even with stale (command-issue-time) targeting.
    expect(liveCreature.x !== startX || liveCreature.y !== startY).toBe(true);
  });

  it("D: closes to within attack range without overshooting past the creature", () => {
    const [creature] = sim.getCreaturesForWorld(world.id);
    const worker = registerTestWorker(13004, creature.x - (WORKER_ATTACK_RANGE + 50), creature.y);
    expect(sim.issueAttackCommand(worker.id, creature.id, colony.id)).toBeNull();

    // Exactly 10 ticks = 1 second = the aphid's idle period, so it hasn't
    // started wandering yet and this geometry stays exact.
    for (let i = 0; i < 10; i++) sim.advanceSimulation(TICK_DT);

    const after = workerById(worker.id);
    const dist = Math.hypot(after.x - creature.x, after.y - creature.y);
    expect(dist).toBeLessThanOrEqual(WORKER_ATTACK_RANGE + 1e-6);
    expect(dist).toBeGreaterThan(WORKER_ATTACK_RANGE - 5);
  });

  it("E: cooldown gates how often damage lands", () => {
    const [creature] = sim.getCreaturesForWorld(world.id);
    const worker = registerTestWorker(13005, creature.x, creature.y);
    expect(sim.issueAttackCommand(worker.id, creature.id, colony.id)).toBeNull();

    sim.advanceSimulation(TICK_DT); // first hit lands immediately — cooldownRemaining starts at 0
    const afterFirstHit = creatureById(creature.id).health;
    expect(afterFirstHit).toBe(creature.health - WORKER_ATTACK_DAMAGE);

    sim.advanceSimulation(TICK_DT); // well within the 1s cooldown
    expect(creatureById(creature.id).health).toBe(afterFirstHit);

    for (let i = 0; i < 15; i++) sim.advanceSimulation(TICK_DT); // clears the cooldown, lands exactly one more hit
    expect(creatureById(creature.id).health).toBe(afterFirstHit - WORKER_ATTACK_DAMAGE);
  });

  it("F: two workers attacking the same creature both land hits in the same tick", () => {
    const [creature] = sim.getCreaturesForWorld(world.id);
    const a = registerTestWorker(13006, creature.x, creature.y);
    const b = registerTestWorker(13007, creature.x + 5, creature.y);
    expect(sim.issueAttackCommand(a.id, creature.id, colony.id)).toBeNull();
    expect(sim.issueAttackCommand(b.id, creature.id, colony.id)).toBeNull();

    sim.advanceSimulation(TICK_DT);

    expect(creatureById(creature.id).health).toBe(creature.health - 2 * WORKER_ATTACK_DAMAGE);
  });

  it("G: damaged health persists through loadSimulation", () => {
    const [creature] = sim.getCreaturesForWorld(world.id);
    const worker = registerTestWorker(13008, creature.x, creature.y);
    expect(sim.issueAttackCommand(worker.id, creature.id, colony.id)).toBeNull();
    sim.advanceSimulation(TICK_DT);
    const damagedHealth = creatureById(creature.id).health;
    expect(damagedHealth).toBeLessThan(creature.maxHealth);

    sim.loadSimulation(); // health is written synchronously on hit — no checkpoint needed

    const reloaded = creatureById(creature.id);
    expect(reloaded.health).toBe(damagedHealth);
    expect(reloaded.maxHealth).toBe(creature.maxHealth);
  });

  it("H: death removes the creature and creates exactly one carcass at its position", () => {
    const [creature] = sim.getCreaturesForWorld(world.id);
    setCreatureHealth(creature.id, WORKER_ATTACK_DAMAGE); // dies in exactly one hit
    const worker = registerTestWorker(13009, creature.x, creature.y);
    expect(sim.issueAttackCommand(worker.id, creature.id, colony.id)).toBeNull();

    sim.advanceSimulation(TICK_DT);

    expect(sim.getCreaturesForWorld(world.id).some((c) => c.id === creature.id)).toBe(false);
    const carcasses = db
      .prepare(
        "SELECT id, x, y, resource_type AS resourceType, amount, max_amount AS maxAmount, kind " +
          "FROM resource_nodes WHERE kind = 'item'",
      )
      .all() as { id: number; x: number; y: number; resourceType: string; amount: number; maxAmount: number; kind: string }[];
    expect(carcasses).toHaveLength(1);
    expect(carcasses[0]).toMatchObject({
      x: creature.x,
      y: creature.y,
      resourceType: "protein",
      amount: APHID_PROTEIN_VALUE,
      maxAmount: APHID_PROTEIN_VALUE,
      kind: "item",
    });
  });

  it("I: the death transaction leaves no partial state in the DB — creature gone, carcass exactly once", () => {
    const [creature] = sim.getCreaturesForWorld(world.id);
    setCreatureHealth(creature.id, WORKER_ATTACK_DAMAGE);
    const worker = registerTestWorker(13010, creature.x, creature.y);
    expect(sim.issueAttackCommand(worker.id, creature.id, colony.id)).toBeNull();

    sim.advanceSimulation(TICK_DT);

    expect((db.prepare("SELECT COUNT(*) AS n FROM creatures WHERE id = ?").get(creature.id) as { n: number }).n).toBe(
      0,
    );
    expect((db.prepare("SELECT COUNT(*) AS n FROM resource_nodes WHERE kind = 'item'").get() as { n: number }).n).toBe(
      1,
    );
  });

  it("J: a carcass depletes like any finite node, never regenerates, and deletes once fully claimed", () => {
    const [creature] = sim.getCreaturesForWorld(world.id);
    setCreatureHealth(creature.id, WORKER_ATTACK_DAMAGE);
    const worker = registerTestWorker(13011, creature.x, creature.y);
    expect(sim.issueAttackCommand(worker.id, creature.id, colony.id)).toBeNull();
    sim.advanceSimulation(TICK_DT); // kill lands, carcass created

    const carcass = db.prepare("SELECT id FROM resource_nodes WHERE kind = 'item'").get() as { id: number };
    expect(fullNodeRow(carcass.id)?.amount).toBe(APHID_PROTEIN_VALUE);

    sim.advanceSimulation(1000); // plenty of time — protein is not in RESOURCE_REGEN_RATES
    expect(fullNodeRow(carcass.id)?.amount).toBe(APHID_PROTEIN_VALUE);

    db.prepare("UPDATE resource_nodes SET amount = ? WHERE id = ?").run(GATHER_YIELD, carcass.id);
    const gatherer = registerTestWorker(13012, creature.x, creature.y);
    expect(sim.issueGatherCommand(gatherer.id, carcass.id, colony.id)).toBeNull();
    sim.advanceSimulation(TICK_DT);

    expect(nodeRow(carcass.id)).toBeUndefined(); // deleted once fully claimed, same as any finite node
  });

  it("K: harvesting a carcass credits protein only after deposit, exactly like any protein node", () => {
    const [creature] = sim.getCreaturesForWorld(world.id);
    setCreatureHealth(creature.id, WORKER_ATTACK_DAMAGE);
    const queen = queenPosition();
    db.prepare("UPDATE creatures SET x = ?, y = ? WHERE id = ?").run(queen.x + 20, queen.y, creature.id);
    sim.loadSimulation();
    const liveCreature = creatureById(creature.id);
    const worker = registerTestWorker(13013, liveCreature.x, liveCreature.y);
    expect(sim.issueAttackCommand(worker.id, liveCreature.id, colony.id)).toBeNull();
    sim.advanceSimulation(TICK_DT); // kill lands; worker goes idle; carcass appears next to the queen

    const beforeColony = resourceAmount("protein");
    const carcass = db.prepare("SELECT id FROM resource_nodes WHERE kind = 'item'").get() as { id: number };
    expect(sim.issueGatherCommand(worker.id, carcass.id, colony.id)).toBeNull();
    sim.advanceSimulation(TICK_DT); // claim resolves: carrying set, command becomes return
    expect(resourceAmount("protein")).toBe(beforeColony); // claiming alone never credits

    sim.advanceSimulation(TICK_DT); // already in deposit range of the queen -> deposits
    expect(resourceAmount("protein")).toBe(beforeColony + GATHER_YIELD);
    expect(workerById(worker.id).carrying).toBeNull();
  });

  it("L: every attacker goes idle in place after a kill — no auto-gather, no auto-retarget", () => {
    const [creature] = sim.getCreaturesForWorld(world.id);
    setCreatureHealth(creature.id, WORKER_ATTACK_DAMAGE);
    const a = registerTestWorker(13014, creature.x, creature.y);
    // Far enough from `a` that the separation system (which runs for every
    // worker every tick, idle or not) has no effect on either once they go
    // idle — otherwise two idle workers standing within MIN_SEPARATION of
    // each other legitimately drift apart, which isn't what this test is
    // checking for. Still within WORKER_ATTACK_RANGE of the creature.
    const b = registerTestWorker(13015, creature.x, creature.y + 25);
    expect(sim.issueAttackCommand(a.id, creature.id, colony.id)).toBeNull();
    expect(sim.issueAttackCommand(b.id, creature.id, colony.id)).toBeNull();

    sim.advanceSimulation(TICK_DT); // kill lands

    expect(sim.getWorkerCommand(a.id)).toBe("idle");
    expect(sim.getWorkerCommand(b.id)).toBe("idle");
    const posA = workerById(a.id);
    const posB = workerById(b.id);

    sim.advanceSimulation(TICK_DT); // must not auto-gather the new carcass or move the now-idle workers
    expect(workerById(a.id).carrying).toBeNull();
    expect(workerById(b.id).carrying).toBeNull();
    expect(sim.getWorkerCommand(a.id)).toBe("idle");
    expect(sim.getWorkerCommand(b.id)).toBe("idle");
    expect(workerById(a.id).x).toBe(posA.x);
    expect(workerById(a.id).y).toBe(posA.y);
    expect(workerById(b.id).x).toBe(posB.x);
    expect(workerById(b.id).y).toBe(posB.y);
  });

  it("a worker whose target dies mid-chase (killed by another attacker) degrades to idle without throwing", () => {
    const [creature] = sim.getCreaturesForWorld(world.id);
    setCreatureHealth(creature.id, WORKER_ATTACK_DAMAGE);
    const killer = registerTestWorker(13016, creature.x, creature.y); // in range immediately
    const approacher = registerTestWorker(13017, creature.x - 500, creature.y); // still far away

    expect(sim.issueAttackCommand(killer.id, creature.id, colony.id)).toBeNull();
    expect(sim.issueAttackCommand(approacher.id, creature.id, colony.id)).toBeNull();

    expect(() => sim.advanceSimulation(TICK_DT)).not.toThrow(); // killer's hit lands and kills it this same tick

    expect(sim.getWorkerCommand(killer.id)).toBe("idle");
    expect(sim.getWorkerCommand(approacher.id)).toBe("idle");
  });

  it("M: a kind='source' protein node still deletes at zero, unaffected by the new kind column", () => {
    const [proteinNode] = findNodesByType("protein");
    expect(fullNodeRow(proteinNode.id)?.kind).toBe("source");
    db.prepare("UPDATE resource_nodes SET amount = ? WHERE id = ?").run(GATHER_YIELD, proteinNode.id);
    const worker = registerTestWorker(13018, proteinNode.x, proteinNode.y);
    expect(sim.issueGatherCommand(worker.id, proteinNode.id, colony.id)).toBeNull();
    sim.advanceSimulation(TICK_DT);
    expect(nodeRow(proteinNode.id)).toBeUndefined();
  });

  it("command override: a second attack retargets the worker, and a move command replaces an attack outright", () => {
    const farCreatureId = insertCreature(100, 100);
    const nearCreatureId = insertCreature(2000, 2000);
    sim.loadSimulation();
    const worker = registerTestWorker(13019, 2000, 2000); // starts on top of the "near" creature

    expect(sim.issueAttackCommand(worker.id, farCreatureId, colony.id)).toBeNull();
    sim.advanceSimulation(TICK_DT); // chasing the far creature, not in range of either yet
    expect(creatureById(farCreatureId).health).toBe(APHID_MAX_HEALTH);
    expect(creatureById(nearCreatureId).health).toBe(APHID_MAX_HEALTH);

    expect(sim.issueAttackCommand(worker.id, nearCreatureId, colony.id)).toBeNull(); // retarget
    sim.advanceSimulation(TICK_DT); // still within range of the near creature -> hits it, not the far one
    expect(creatureById(nearCreatureId).health).toBe(APHID_MAX_HEALTH - WORKER_ATTACK_DAMAGE);
    expect(creatureById(farCreatureId).health).toBe(APHID_MAX_HEALTH); // untouched — override abandoned it

    expect(sim.issueMoveCommand(worker.id, 2500, 2500, colony.id)).toBeNull(); // move replaces attack outright
    sim.advanceSimulation(TICK_DT);
    expect(sim.getWorkerCommand(worker.id)).toBe("move");
  });

  it("restart: health persists but an in-progress attack command does not", () => {
    const [creature] = sim.getCreaturesForWorld(world.id);
    const [worker] = sim.getWorkersForColony(colony.id); // a real seeded worker — survives reload
    sim.registerWorker({ id: worker.id, colonyId: colony.id, x: creature.x, y: creature.y });
    expect(sim.issueAttackCommand(worker.id, creature.id, colony.id)).toBeNull();
    sim.advanceSimulation(TICK_DT);

    const damagedHealth = creatureById(creature.id).health;
    expect(damagedHealth).toBeLessThan(creature.maxHealth);
    expect(sim.getWorkerCommand(worker.id)).toBe("attack");

    sim.checkpointSimulation();
    sim.loadSimulation(); // simulates a restart

    expect(sim.getWorkerCommand(worker.id)).toBe("idle"); // ephemeral attack command does not survive
    expect(creatureById(creature.id).health).toBe(damagedHealth); // durable health does survive
  });

  it("restart: an unclaimed carcass persists across a reload", () => {
    const [creature] = sim.getCreaturesForWorld(world.id);
    setCreatureHealth(creature.id, WORKER_ATTACK_DAMAGE);
    const worker = registerTestWorker(13020, creature.x, creature.y);
    expect(sim.issueAttackCommand(worker.id, creature.id, colony.id)).toBeNull();
    sim.advanceSimulation(TICK_DT); // kill lands, carcass created

    const carcass = db.prepare("SELECT id, amount FROM resource_nodes WHERE kind = 'item'").get() as {
      id: number;
      amount: number;
    };

    sim.loadSimulation(); // resource nodes aren't cached in memory — nothing here should change them

    expect(nodeRow(carcass.id)?.amount).toBe(carcass.amount);
  });
});
