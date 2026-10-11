import {
  GATHER_RANGE,
  GATHER_YIELD,
  GROUP_DESTINATION_SPACING,
  MIN_SEPARATION,
  SEPARATION_STRENGTH,
  WORKER_SPEED,
} from "./balance.ts";
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

// Stage 3: a group move's clicked point is the centre of a loose destination
// area, not a shared exact target — this computes each worker's own nearby
// slot. A lone worker always gets the exact centre, untouched (no clamping
// either), so a solo move's existing bounds-validation behaviour in
// issueMoveCommand is completely unchanged. See CLAUDE.md.
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export function computeGroupDestinations(
  workerIds: number[],
  centerX: number,
  centerY: number,
): Map<number, { x: number; y: number }> {
  const destinations = new Map<number, { x: number; y: number }>();
  if (workerIds.length === 1) {
    destinations.set(workerIds[0], { x: centerX, y: centerY });
    return destinations;
  }
  // Sorted ascending so the slot each worker lands on is deterministic
  // regardless of the order ids arrive in the request.
  const sorted = [...workerIds].sort((a, b) => a - b);
  sorted.forEach((id, i) => {
    // A golden-angle phyllotaxis spiral — organic, non-overlapping, and
    // deliberately not rows/columns (an insect swarm, not a formation).
    const radius = GROUP_DESTINATION_SPACING * Math.sqrt(i);
    const angle = i * GOLDEN_ANGLE;
    const x = clamp(centerX + radius * Math.cos(angle), 0, worldBounds.width);
    const y = clamp(centerY + radius * Math.sin(angle), 0, worldBounds.height);
    destinations.set(id, { x, y });
  });
  return destinations;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// Both arrival checks in advanceSimulation compare a `Math.hypot`-derived
// distance against arrivalRange. Landing exactly on the boundary is common
// (a tick's step is deliberately sized to close the remaining distance to
// arrivalRange exactly), but hypot's rounding can put the result a sliver
// above it instead of exactly on or under it — observed in production as a
// worker parked at dist = 30.00000000000002 against a GATHER_RANGE of 30,
// where the resulting step (~2e-14) was smaller than a coordinate's own
// floating-point precision and so never actually moved it: permanently
// stuck a hair outside range, claim never attempted. This tolerance is far
// below anything that could matter at this simulation's scale. See CLAUDE.md.
const ARRIVAL_EPSILON = 1e-6;

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

// Stage 3: a uniform spatial hash rebuilt fresh every tick from everyone's
// pre-tick position, so separation never scans all O(n^2) pairs — each
// worker only looks at its own cell and its 8 neighbours. Cell size equals
// MIN_SEPARATION itself: any worker closer than that can only ever land in
// one of those 9 cells. Internal to this module.
function cellKey(x: number, y: number): string {
  return `${Math.floor(x / MIN_SEPARATION)}:${Math.floor(y / MIN_SEPARATION)}`;
}

interface GridEntry {
  id: number;
  x: number;
  y: number;
}

// Snapshots {id, x, y} rather than storing the live SimWorker reference —
// advanceSimulation mutates worker.x/y in place as it processes the Map in
// order, so a grid of live references would let a later worker in the same
// tick see an earlier worker's already-moved position (Gauss-Seidel) instead
// of where everyone started the tick (Jacobi), silently breaking the
// order-independence this is supposed to guarantee.
function buildSpatialGrid(): Map<string, GridEntry[]> {
  const grid = new Map<string, GridEntry[]>();
  for (const worker of workers.values()) {
    const key = cellKey(worker.x, worker.y);
    const entry = { id: worker.id, x: worker.x, y: worker.y };
    const cell = grid.get(key);
    if (cell) cell.push(entry);
    else grid.set(key, [entry]);
  }
  return grid;
}

// How far (and in which direction) a worker should nudge this tick to stay
// off its too-close neighbours — found via the grid above, snapshotted at
// the start of the tick (Jacobi-style: based on where everyone *started*
// the tick, not on neighbours that already moved earlier in the same loop,
// so the result never depends on Map iteration order).
//
// MIN_SEPARATION's strict `<` trigger (not `<=`) is deliberate: it's what
// keeps this from ever firing in spec/simulation.test.ts's "arrival" test,
// whose fixed seed geometry places a worker exactly MIN_SEPARATION away
// from that test's target. See balance.ts and CLAUDE.md.
function separationDelta(worker: SimWorker, grid: Map<string, GridEntry[]>, dt: number): { dx: number; dy: number } {
  const cellX = Math.floor(worker.x / MIN_SEPARATION);
  const cellY = Math.floor(worker.y / MIN_SEPARATION);
  let pushX = 0;
  let pushY = 0;
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      const neighbours = grid.get(`${cellX + ox}:${cellY + oy}`);
      if (!neighbours) continue;
      for (const other of neighbours) {
        if (other.id === worker.id) continue;
        const dx = worker.x - other.x;
        const dy = worker.y - other.y;
        const dist = Math.hypot(dx, dy);
        if (dist >= MIN_SEPARATION) continue;
        let ux: number;
        let uy: number;
        if (dist < 1e-9) {
          // Exactly coincident: fall back to a direction derived from the id
          // difference, so two stacked workers reliably separate instead of
          // producing a NaN or an arbitrary (non-deterministic) push.
          const angle = (worker.id - other.id) * GOLDEN_ANGLE;
          ux = Math.cos(angle);
          uy = Math.sin(angle);
        } else {
          ux = dx / dist;
          uy = dy / dist;
        }
        const overlap = (MIN_SEPARATION - dist) / MIN_SEPARATION;
        pushX += ux * SEPARATION_STRENGTH * overlap;
        pushY += uy * SEPARATION_STRENGTH * overlap;
      }
    }
  }
  let dx = pushX * dt;
  let dy = pushY * dt;
  const maxStep = WORKER_SPEED * dt;
  const mag = Math.hypot(dx, dy);
  if (mag > maxStep) {
    const scale = maxStep / mag;
    dx *= scale;
    dy *= scale;
  }
  return { dx, dy };
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
//
// Stage 3: every worker, idle or not, also gets a separation nudge away from
// anyone too close (see separationDelta) — that's what keeps a settled group
// from staying stacked, and what keeps an approaching group from visually
// overlapping. Arrival is decided from the attraction step alone, *before*
// separation is added: a target is often exactly where a neighbour stands
// (a shared gather node, a spot another worker just left), so separation
// there frequently points straight against attraction, and letting it onto
// an arriving tick could cancel the final step and stall a claim forever.
// Separation can still delay an arrival on a tick that doesn't reach it, but
// never blocks one that does, and every resulting position is clamped into
// world bounds so separation can never push a worker out of them.
export function advanceSimulation(dt: number): void {
  const grid = buildSpatialGrid();

  for (const worker of workers.values()) {
    const separation = separationDelta(worker, grid, dt);

    if (worker.command.type === "idle") {
      if (separation.dx !== 0 || separation.dy !== 0) {
        const newX = clamp(worker.x + separation.dx, 0, worldBounds.width);
        const newY = clamp(worker.y + separation.dy, 0, worldBounds.height);
        if (newX !== worker.x || newY !== worker.y) {
          worker.x = newX;
          worker.y = newY;
          dirty = true;
        }
      }
      continue;
    }

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

    if (dist <= arrivalRange + ARRIVAL_EPSILON) {
      if (command.type === "gather") attemptGatherClaim(worker, command.resourceId);
      worker.command = { type: "idle" };
      continue;
    }

    // Attraction is resolved on its own first, and arrival is decided from
    // *that* alone — separation is added only on a tick that doesn't arrive.
    // A target a worker is heading for is often exactly where a neighbour is
    // standing (the node a group is gathering, the spot another worker just
    // vacated), so separation's pull is frequently pointed dead against
    // attraction there; letting it onto an arriving tick could cancel the
    // final step and stall the claim indefinitely. See CLAUDE.md.
    const step = Math.min(WORKER_SPEED * dt, dist - arrivalRange);
    const attractedX = worker.x + (dx / dist) * step;
    const attractedY = worker.y + (dy / dist) * step;
    const attractedDist = Math.hypot(targetX - attractedX, targetY - attractedY);

    if (attractedDist <= arrivalRange + ARRIVAL_EPSILON) {
      worker.x = clamp(attractedX, 0, worldBounds.width);
      worker.y = clamp(attractedY, 0, worldBounds.height);
      dirty = true;
      if (command.type === "gather") attemptGatherClaim(worker, command.resourceId);
      worker.command = { type: "idle" };
      continue;
    }

    worker.x = clamp(attractedX + separation.dx, 0, worldBounds.width);
    worker.y = clamp(attractedY + separation.dy, 0, worldBounds.height);
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
