import { WORKER_SPEED } from "./balance.ts";
import { db } from "./db.ts";

// The authoritative simulation lives here, in memory — not in SQLite and not
// derived fresh from it on every read. SQLite only ever holds the last
// checkpoint (see checkpointSimulation). getState()/broadcastState() must
// read worker positions through this module, never straight from the
// `workers` table, or they'd show stale, pre-tick positions. See CLAUDE.md.

type WorkerCommand = { type: "idle" } | { type: "move"; targetX: number; targetY: number };

interface SimWorker {
  id: number;
  colonyId: number;
  x: number;
  y: number;
  command: WorkerCommand;
}

export type MoveCommandError = "no such worker" | "invalid coordinates" | "coordinates out of bounds";

const workers = new Map<number, SimWorker>();
let worldBounds = { width: 0, height: 0 };
let dirty = false;

// Loads authoritative state from SQLite — the last checkpoint, or the
// initial seed on a first boot. Every worker starts idle: in-flight commands
// are never persisted, so a restart always drops them (see CLAUDE.md).
export function loadSimulation(): void {
  const world = db.prepare("SELECT width, height FROM worlds LIMIT 1").get() as
    | { width: number; height: number }
    | undefined;
  worldBounds = world ?? { width: 0, height: 0 };

  workers.clear();
  const rows = db.prepare("SELECT id, colony_id AS colonyId, x, y FROM workers").all() as {
    id: number;
    colonyId: number;
    x: number;
    y: number;
  }[];
  for (const row of rows) {
    workers.set(row.id, { ...row, command: { type: "idle" } });
  }
  dirty = false;
}

// Registers a worker created outside the simulation (reproduce() inserts it
// straight into SQLite). Without this the sim cache and SQLite would diverge
// the moment a new worker arrived — getState() would never see it move.
export function registerWorker(worker: { id: number; colonyId: number; x: number; y: number }): void {
  workers.set(worker.id, { ...worker, command: { type: "idle" } });
}

export function getWorkersForColony(colonyId: number): { id: number; x: number; y: number }[] {
  return [...workers.values()]
    .filter((w) => w.colonyId === colonyId)
    .sort((a, b) => a.id - b.id)
    .map(({ id, x, y }) => ({ id, x, y }));
}

export function getWorkerCommand(workerId: number): "idle" | "move" {
  const worker = workers.get(workerId);
  if (!worker) throw new Error(`no such worker: ${workerId}`);
  return worker.command.type;
}

export function issueMoveCommand(workerId: number, x: number, y: number): MoveCommandError | null {
  const worker = workers.get(workerId);
  if (!worker) return "no such worker";
  if (!Number.isFinite(x) || !Number.isFinite(y)) return "invalid coordinates";
  if (x < 0 || x > worldBounds.width || y < 0 || y > worldBounds.height) return "coordinates out of bounds";
  worker.command = { type: "move", targetX: x, targetY: y };
  return null;
}

// The only mutation path for position: synchronous, no await, so it can
// never interleave with an HTTP handler's own synchronous mutation (the same
// single-process guarantee Crit 9 relies on for gather/reproduce).
export function advanceSimulation(dt: number): void {
  for (const worker of workers.values()) {
    if (worker.command.type !== "move") continue;
    const dx = worker.command.targetX - worker.x;
    const dy = worker.command.targetY - worker.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) {
      worker.command = { type: "idle" };
      continue;
    }
    const step = WORKER_SPEED * dt;
    if (step >= dist) {
      worker.x = worker.command.targetX;
      worker.y = worker.command.targetY;
      worker.command = { type: "idle" };
    } else {
      worker.x += (dx / dist) * step;
      worker.y += (dy / dist) * step;
    }
    dirty = true;
  }
}

// The periodic broadcast loop calls this to decide whether there's anything
// new to send — an idle world shouldn't push identical frames forever.
export function consumeDirty(): boolean {
  const was = dirty;
  dirty = false;
  return was;
}

// Flushes in-memory positions to SQLite in one transaction. Called on an
// interval and on graceful shutdown — never on every tick, which would turn
// continuous movement into a continuous write load. Commands are never
// written: only position is durable (see CLAUDE.md).
export function checkpointSimulation(): void {
  const update = db.prepare("UPDATE workers SET x = ?, y = ? WHERE id = ?");
  const tx = db.transaction((list: SimWorker[]) => {
    for (const w of list) update.run(w.x, w.y, w.id);
  });
  tx([...workers.values()]);
}

loadSimulation();
