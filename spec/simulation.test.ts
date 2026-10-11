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
const { SIMULATION } = await import("../src/server/balance.ts");

const TICK_DT = 1 / SIMULATION.tickHz;

const colony = db.prepare("SELECT id FROM colonies LIMIT 1").get() as { id: number };
const world = db.prepare("SELECT width, height FROM worlds LIMIT 1").get() as { width: number; height: number };

function workerById(id: number) {
  const found = sim.getWorkersForColony(colony.id).find((w) => w.id === id);
  if (!found) throw new Error(`no such worker in sim state: ${id}`);
  return found;
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
