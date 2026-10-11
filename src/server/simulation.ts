import { GATHER_RANGE, GATHER_YIELD, WORKER_SPEED } from "./balance.ts";
import { db } from "./db.ts";

// The authoritative simulation lives here, in memory — not in SQLite and not
// derived fresh from it on every read. SQLite only ever holds the last
// checkpoint (see checkpointSimulation). getState()/broadcastState() must
// read worker positions through this module, never straight from the
// `workers` table, or they'd show stale, pre-tick positions. See CLAUDE.md.

type WorkerCommand =
  | { type: "idle" }
  | { type: "move"; targetX: number; targetY: number }
  | { type: "gather"; resourceId: number; lastKnownX: number; lastKnownY: number };

interface SimWorker {
  id: number;
  colonyId: number;
  x: number;
  y: number;
  command: WorkerCommand;
}

export type MoveCommandError = "no such worker" | "invalid coordinates" | "coordinates out of bounds";
export type GatherCommandError = "no such worker" | "no such resource node";

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
  // ORDER BY id makes Map insertion order (and therefore advanceSimulation's
  // iteration order) deterministic — load-bearing for contested resource
  // claims, where the worker processed first wins. See CLAUDE.md.
  const rows = db.prepare("SELECT id, colony_id AS colonyId, x, y FROM workers ORDER BY id").all() as {
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

export function getWorkerCommand(workerId: number): "idle" | "move" | "gather" {
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

// Issuing a gather command only starts travel — it never credits anything
// itself (see attemptGatherClaim, which only runs on arrival). The resource's
// position is captured now, as lastKnownX/Y, so the worker still has
// somewhere to walk to if the resource is claimed out from under it before
// it arrives (see advanceSimulation).
export function issueGatherCommand(workerId: number, resourceId: number): GatherCommandError | null {
  const worker = workers.get(workerId);
  if (!worker) return "no such worker";
  const node = db.prepare("SELECT x, y FROM resource_nodes WHERE id = ?").get(resourceId) as
    | { x: number; y: number }
    | undefined;
  if (!node) return "no such resource node";
  worker.command = { type: "gather", resourceId, lastKnownX: node.x, lastKnownY: node.y };
  return null;
}

function findResourceNode(id: number): { resourceType: string; amount: number | null } | undefined {
  return db.prepare("SELECT resource_type AS resourceType, amount FROM resource_nodes WHERE id = ?").get(id) as
    | { resourceType: string; amount: number | null }
    | undefined;
}

function creditColony(colonyId: number, resourceType: string, amount: number): void {
  db.prepare(
    `INSERT INTO colony_resources (colony_id, resource_type, amount) VALUES (?, ?, ?)
     ON CONFLICT(colony_id, resource_type) DO UPDATE SET amount = amount + excluded.amount`,
  ).run(colonyId, resourceType, amount);
}

// The claim itself: synchronous, no await, atomic per node — same
// single-process guarantee Crit 9 relies on for reproduce(). Re-reads the
// row rather than trusting any cached amount, because another worker
// processed earlier in this same tick may have just deleted or reduced it
// (see advanceSimulation's contested-claim handling).
function attemptGatherClaim(worker: SimWorker, resourceId: number): void {
  const node = findResourceNode(resourceId);
  if (!node) return; // already claimed/depleted by someone else this tick

  if (node.amount === null) {
    creditColony(worker.colonyId, node.resourceType, GATHER_YIELD);
    dirty = true;
    return;
  }

  const claimed = Math.min(GATHER_YIELD, node.amount);
  if (claimed <= 0) {
    db.prepare("DELETE FROM resource_nodes WHERE id = ?").run(resourceId);
    dirty = true;
    return;
  }
  const remaining = node.amount - claimed;
  const tx = db.transaction(() => {
    creditColony(worker.colonyId, node.resourceType, claimed);
    if (remaining <= 0) {
      db.prepare("DELETE FROM resource_nodes WHERE id = ?").run(resourceId);
    } else {
      db.prepare("UPDATE resource_nodes SET amount = ? WHERE id = ?").run(remaining, resourceId);
    }
  });
  tx();
  dirty = true;
}

// The only mutation path for position and resource claims: synchronous, no
// await, so neither can ever interleave with an HTTP handler's own
// synchronous mutation, nor with each other across workers in the same tick
// (the same single-process guarantee Crit 9 relies on for reproduce()).
//
// A `gather` command reuses the exact same step-toward-target movement as a
// `move` command — the only difference is the arrival distance (GATHER_RANGE
// instead of exactly zero) and what happens on arrival (a claim attempt).
// There is deliberately only one movement implementation.
export function advanceSimulation(dt: number): void {
  for (const worker of workers.values()) {
    if (worker.command.type === "idle") continue;

    // A resource that's disappeared since this command was issued (claimed
    // by another worker) converts the command into a plain move toward its
    // last-known position — same target, no further claim attempt. This
    // check runs once per tick, before movement, so it's also what lets a
    // worker processed later in the very same tick as a depleting claim
    // discover it immediately.
    if (worker.command.type === "gather" && !findResourceNode(worker.command.resourceId)) {
      worker.command = { type: "move", targetX: worker.command.lastKnownX, targetY: worker.command.lastKnownY };
    }

    const command = worker.command;

    const targetX = command.type === "move" ? command.targetX : command.lastKnownX;
    const targetY = command.type === "move" ? command.targetY : command.lastKnownY;
    const arrivalRange = command.type === "gather" ? GATHER_RANGE : 0;

    const dx = targetX - worker.x;
    const dy = targetY - worker.y;
    const dist = Math.hypot(dx, dy);

    if (dist <= arrivalRange) {
      if (command.type === "gather") attemptGatherClaim(worker, command.resourceId);
      worker.command = { type: "idle" };
      continue;
    }

    const step = Math.min(WORKER_SPEED * dt, dist - arrivalRange);
    worker.x += (dx / dist) * step;
    worker.y += (dy / dist) * step;
    dirty = true;

    if (dist - arrivalRange <= WORKER_SPEED * dt) {
      if (command.type === "gather") attemptGatherClaim(worker, command.resourceId);
      worker.command = { type: "idle" };
    }
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
