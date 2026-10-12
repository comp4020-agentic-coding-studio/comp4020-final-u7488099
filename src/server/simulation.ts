import {
  APHID_IDLE_MAX,
  APHID_IDLE_MIN,
  APHID_PROTEIN_VALUE,
  APHID_SPEED,
  APHID_WANDER_RADIUS,
  DEPOSIT_RANGE,
  GATHER_RANGE,
  GATHER_YIELD,
  GOLDEN_ANGLE,
  GROUP_DESTINATION_SPACING,
  MIN_SEPARATION,
  RESOURCE_REGEN_RATES,
  SEPARATION_STRENGTH,
  SPIDER_AGGRO_RANGE,
  SPIDER_ATTACK_COOLDOWN,
  SPIDER_ATTACK_DAMAGE,
  SPIDER_ATTACK_RANGE,
  SPIDER_DISENGAGE_RANGE,
  SPIDER_IDLE_MAX,
  SPIDER_IDLE_MIN,
  SPIDER_SPEED,
  SPIDER_WANDER_RADIUS,
  WORKER_ATTACK_COOLDOWN,
  WORKER_ATTACK_DAMAGE,
  WORKER_ATTACK_RANGE,
  WORKER_SPEED,
} from "./balance.ts";
import { db } from "./db.ts";
import { logAction } from "./log.ts";

// The authoritative simulation lives here, in memory — not in SQLite and not
// derived fresh from it on every read. SQLite only ever holds the last
// checkpoint (see checkpointSimulation). getState()/broadcastState() must
// read worker positions through this module, never straight from the
// `workers` table, or they'd show stale, pre-tick positions. See CLAUDE.md.

export type Carrying = { resourceType: string; amount: number } | null;

type WorkerCommand =
  | { type: "idle" }
  | { type: "move"; targetX: number; targetY: number }
  | { type: "gather"; resourceId: number; lastKnownX: number; lastKnownY: number }
  | { type: "return" } // target is always the worker's own colony's nest — see nestPositions
  // Stage 6: ephemeral, same category as the rest — never written to the
  // workers table, always reset to idle on loadSimulation(). No
  // lastKnownX/Y: the target creature's live position is re-read from the
  // `creatures` Map every tick (see handleAttackCommand), not captured once
  // at issue time like gather's lastKnownX/Y is.
  | { type: "attack"; creatureId: number; cooldownRemaining: number };

interface SimWorker {
  id: number;
  colonyId: number;
  x: number;
  y: number;
  carrying: Carrying;
  command: WorkerCommand;
  // Stage 7: durable health (see db.ts's workers table). Loaded fresh from
  // SQLite on every loadSimulation(), same precedent as SimCreature's
  // health/maxHealth — a restart never silently heals an injured worker.
  health: number;
  maxHealth: number;
}

export type MoveCommandError =
  | "no such worker"
  | "invalid coordinates"
  | "coordinates out of bounds"
  | "worker is busy returning resources";
export type GatherCommandError = "no such worker" | "no such resource node" | "worker is busy returning resources";
export type AttackCommandError = "no such worker" | "no such creature" | "worker is busy returning resources";

// Stage 5: a neutral creature (first species: aphid). Stage 6 makes it
// interactable: health/maxHealth are durable (see db.ts's creatures table),
// loaded fresh from SQLite on every loadSimulation() rather than defaulted
// in memory, so a restart never silently resets an injured aphid to full
// health. See CLAUDE.md.
interface SimCreature {
  id: number;
  worldId: number;
  species: string;
  x: number;
  y: number;
  health: number;
  maxHealth: number;
  command: CreatureCommand;
  rngState: number; // not exposed externally; reseeded fresh on every loadSimulation()
}

// Stage 7: "chase" is a third ephemeral variant, same durability rule as
// idle/wander — never persisted, always dropped back to idle on a restart
// (see loadSimulation). targetWorkerId is looked up live in workers.get()
// every tick, never a captured position, exactly like a worker's own
// "attack" command looks up its creature target live. See CLAUDE.md.
type CreatureCommand =
  | { type: "idle"; remaining: number }
  | { type: "wander"; targetX: number; targetY: number }
  | { type: "chase"; targetWorkerId: number; cooldownRemaining: number };

const creatures = new Map<number, SimCreature>();

const workers = new Map<number, SimWorker>();
let worldBounds = { width: 0, height: 0 };
// Queen/nest position per colony, cached once per loadSimulation() — nothing
// ever updates colonies.queen_x/y after seeding, so this is safe to treat as
// immutable for the life of the process. Used to resolve a `return`
// command's target without a query on every tick.
const nestPositions = new Map<number, { x: number; y: number }>();
let dirty = false;

// Loads authoritative state from SQLite — the last checkpoint, or the
// initial seed on a first boot. A worker with no carried payload starts
// idle, same as before; a worker restored mid-carry (Stage 4) instead starts
// with a `return` command, since an undeposited payload is real value that
// must keep heading home rather than silently sitting idle. See CLAUDE.md.
export function loadSimulation(): void {
  const world = db.prepare("SELECT width, height FROM worlds LIMIT 1").get() as
    | { width: number; height: number }
    | undefined;
  worldBounds = world ?? { width: 0, height: 0 };

  nestPositions.clear();
  const colonyRows = db.prepare("SELECT id, queen_x AS x, queen_y AS y FROM colonies").all() as {
    id: number;
    x: number;
    y: number;
  }[];
  for (const row of colonyRows) nestPositions.set(row.id, { x: row.x, y: row.y });

  workers.clear();
  // ORDER BY id makes Map insertion order (and therefore advanceSimulation's
  // iteration order) deterministic — load-bearing for contested resource
  // claims, where the worker processed first wins. See CLAUDE.md.
  const rows = db
    .prepare(
      "SELECT id, colony_id AS colonyId, x, y, carrying_type AS carryingType, carrying_amount AS carryingAmount, health, max_health AS maxHealth FROM workers ORDER BY id",
    )
    .all() as {
    id: number;
    colonyId: number;
    x: number;
    y: number;
    carryingType: string | null;
    carryingAmount: number | null;
    health: number;
    maxHealth: number;
  }[];
  for (const row of rows) {
    const carrying: Carrying =
      row.carryingType !== null && row.carryingAmount !== null
        ? { resourceType: row.carryingType, amount: row.carryingAmount }
        : null;
    workers.set(row.id, {
      id: row.id,
      colonyId: row.colonyId,
      x: row.x,
      y: row.y,
      carrying,
      command: carrying ? { type: "return" } : { type: "idle" },
      health: row.health,
      maxHealth: row.maxHealth,
    });
  }

  // Ephemeral wander state (idle/wander, remaining time, target) doesn't need
  // to survive a restart, so every reload starts each creature idle-briefly
  // rather than restoring whatever it was mid-leg doing — it reads as "it
  // paused, then kept wandering". Only existence and position are durable.
  // See CLAUDE.md.
  creatures.clear();
  const creatureRows = db
    .prepare("SELECT id, world_id AS worldId, species, x, y, health, max_health AS maxHealth FROM creatures ORDER BY id")
    .all() as {
    id: number;
    worldId: number;
    species: string;
    x: number;
    y: number;
    health: number;
    maxHealth: number;
  }[];
  for (const row of creatureRows) {
    creatures.set(row.id, {
      ...row,
      command: { type: "idle", remaining: WANDER_PARAMS[row.species].idleMin },
      rngState: seedRng(row.id),
    });
  }

  dirty = false;
}

// Small deterministic xorshift32 PRNG, seeded from the creature's own id —
// wander destinations are reproducible for a given seed and tick sequence
// without relying on Math.random(). See CLAUDE.md.
function seedRng(id: number): number {
  const seed = (id * 0x9e3779b1) >>> 0;
  return seed === 0 ? 1 : seed;
}

function nextRandom(creature: SimCreature): number {
  let x = creature.rngState;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  creature.rngState = x >>> 0;
  return creature.rngState / 0xffffffff;
}

// Stage 7: wander tuning is species-keyed rather than hardcoded to the aphid
// constants, so advanceWander (below) is reusable for any neutral/wandering
// species — today aphid and spider, both already seeded by the time
// loadSimulation()'s top-level call (end of file) runs. See CLAUDE.md.
const WANDER_PARAMS: Record<string, { speed: number; wanderRadius: number; idleMin: number; idleMax: number }> = {
  aphid: { speed: APHID_SPEED, wanderRadius: APHID_WANDER_RADIUS, idleMin: APHID_IDLE_MIN, idleMax: APHID_IDLE_MAX },
  spider: {
    speed: SPIDER_SPEED,
    wanderRadius: SPIDER_WANDER_RADIUS,
    idleMin: SPIDER_IDLE_MIN,
    idleMax: SPIDER_IDLE_MAX,
  },
};

function pickWanderTarget(
  creature: SimCreature,
  params: { wanderRadius: number },
): { x: number; y: number } {
  const angle = nextRandom(creature) * Math.PI * 2;
  const dist = nextRandom(creature) * params.wanderRadius;
  return {
    x: clamp(creature.x + Math.cos(angle) * dist, 0, worldBounds.width),
    y: clamp(creature.y + Math.sin(angle) * dist, 0, worldBounds.height),
  };
}

function pickIdleDuration(creature: SimCreature, params: { idleMin: number; idleMax: number }): number {
  return params.idleMin + nextRandom(creature) * (params.idleMax - params.idleMin);
}

// Idle -> choose a nearby destination -> walk toward it -> arrive -> idle
// briefly -> repeat. Same step-capped movement idiom as workers, but with no
// separation/collision against workers or other creatures, and no spatial
// grid — neither aphids nor spiders need either. Shared by every species via
// WANDER_PARAMS; a spider falls into this whenever it isn't chasing (see
// advanceSpider).
function advanceWander(creature: SimCreature, dt: number): void {
  const params = WANDER_PARAMS[creature.species];
  const command = creature.command;
  if (command.type === "idle") {
    const remaining = command.remaining - dt;
    if (remaining <= 0) {
      const target = pickWanderTarget(creature, params);
      creature.command = { type: "wander", targetX: target.x, targetY: target.y };
    } else {
      creature.command = { type: "idle", remaining };
    }
    return;
  }
  if (command.type !== "wander") return; // chase is handled by advanceSpider, never reaches here
  const dx = command.targetX - creature.x;
  const dy = command.targetY - creature.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= ARRIVAL_EPSILON) {
    creature.command = { type: "idle", remaining: pickIdleDuration(creature, params) };
    return;
  }
  const step = Math.min(params.speed * dt, dist);
  creature.x = clamp(creature.x + (dx / dist) * step, 0, worldBounds.width);
  creature.y = clamp(creature.y + (dy / dist) * step, 0, worldBounds.height);
  dirty = true;
}

// Stage 7: spider AI. Chasing always re-reads the live worker by id (never a
// captured position), so a spider follows where the worker actually is, not
// where it was when aggro triggered — same "live lookup, safe-degrade to
// idle if the target's gone" idiom handleAttackCommand already uses for the
// reverse direction (worker chasing creature). When not chasing, a spider
// scans the full shared `workers` map (every colony, deliberately
// ownership-blind — see CLAUDE.md) for the nearest worker within
// SPIDER_AGGRO_RANGE, tie-broken explicitly by ascending worker id for
// determinism (an explicit id comparison, not reliance on Map iteration
// order — registerWorker() appends in call order, not id order, so only
// a fresh loadSimulation() happens to iterate ascending). Queens are
// structurally unreachable here: they live only in the colonies table,
// never in the workers Map, so this scan can never select one — no guard
// code needed.
function advanceSpider(spider: SimCreature, dt: number): void {
  const command = spider.command;
  if (command.type === "chase") {
    const target = workers.get(command.targetWorkerId);
    if (!target) {
      spider.command = { type: "idle", remaining: pickIdleDuration(spider, WANDER_PARAMS.spider) };
      return;
    }

    const dx = target.x - spider.x;
    const dy = target.y - spider.y;
    const dist = Math.hypot(dx, dy);

    if (dist > SPIDER_DISENGAGE_RANGE) {
      spider.command = { type: "idle", remaining: pickIdleDuration(spider, WANDER_PARAMS.spider) };
      return;
    }

    if (dist > SPIDER_ATTACK_RANGE) {
      const step = Math.min(SPIDER_SPEED * dt, dist - SPIDER_ATTACK_RANGE + ARRIVAL_EPSILON);
      spider.x = clamp(spider.x + (dx / dist) * step, 0, worldBounds.width);
      spider.y = clamp(spider.y + (dy / dist) * step, 0, worldBounds.height);
      dirty = true;
    }

    const cooldownRemaining = Math.max(0, command.cooldownRemaining - dt);
    if (dist <= SPIDER_ATTACK_RANGE && cooldownRemaining <= 0) {
      applyDamageToWorker(target.id, SPIDER_ATTACK_DAMAGE, spider.id);
      // applyDamageToWorker's killWorker sweep may already have reset this
      // spider to idle if that hit was lethal — only write the cooldown
      // back if the command is still "chase".
      if (spider.command.type === "chase") {
        spider.command = { ...spider.command, cooldownRemaining: SPIDER_ATTACK_COOLDOWN };
      }
    } else if (spider.command.type === "chase") {
      spider.command = { ...spider.command, cooldownRemaining };
    }
    return;
  }

  let nearest: SimWorker | null = null;
  let nearestDist = Infinity;
  for (const worker of workers.values()) {
    const dist = Math.hypot(worker.x - spider.x, worker.y - spider.y);
    if (dist > SPIDER_AGGRO_RANGE) continue;
    // Explicit id tiebreak rather than relying on workers.values() iteration
    // order: that order matches ascending id only for workers loaded via
    // loadSimulation()'s ORDER BY id query, not for ones appended later via
    // registerWorker() in call order (e.g. reproduce(), or test helpers).
    if (dist < nearestDist || (dist === nearestDist && nearest !== null && worker.id < nearest.id)) {
      nearest = worker;
      nearestDist = dist;
    }
  }
  if (nearest) {
    spider.command = { type: "chase", targetWorkerId: nearest.id, cooldownRemaining: 0 };
    return;
  }

  advanceWander(spider, dt);
}

function advanceCreatures(dt: number): void {
  for (const creature of creatures.values()) {
    if (creature.species === "spider") {
      advanceSpider(creature, dt);
    } else {
      advanceWander(creature, dt);
    }
  }
}

export function getCreaturesForWorld(
  worldId: number,
): { id: number; species: string; x: number; y: number; health: number; maxHealth: number }[] {
  return [...creatures.values()]
    .filter((c) => c.worldId === worldId)
    .sort((a, b) => a.id - b.id)
    .map(({ id, species, x, y, health, maxHealth }) => ({ id, species, x, y, health, maxHealth }));
}

// Resource nodes have no in-memory cache (every claim already mutates SQLite
// directly — see attemptGatherClaim), so regen follows that same precedent: a
// direct SQL UPDATE per renewable type, run every tick. Each UPDATE commits
// atomically on its own, just not inside the same transaction as a claim —
// worst case a crash loses a fraction of one tick's regen, which is fine per
// the brief (not required to be crash-perfect). The `amount IS NOT NULL`
// guard is what keeps a genuinely infinite node (amount: null) out of this
// entirely — it never matches this WHERE clause. See CLAUDE.md.
const regenStatements = new Map(
  Object.keys(RESOURCE_REGEN_RATES).map((type) => [
    type,
    db.prepare(
      "UPDATE resource_nodes SET amount = MIN(max_amount, amount + ?) " +
        "WHERE resource_type = ? AND amount IS NOT NULL AND max_amount IS NOT NULL AND amount < max_amount",
    ),
  ]),
);

function advanceResourceRegen(dt: number): void {
  for (const [type, rate] of Object.entries(RESOURCE_REGEN_RATES)) {
    const info = regenStatements.get(type)!.run(rate * dt, type);
    if (info.changes > 0) dirty = true;
  }
}

// Registers a worker created outside the simulation (reproduce() inserts it
// straight into SQLite). Without this the sim cache and SQLite would diverge
// the moment a new worker arrived — getState() would never see it move. A
// freshly hatched worker never starts out carrying anything.
export function registerWorker(worker: {
  id: number;
  colonyId: number;
  x: number;
  y: number;
  health: number;
  maxHealth: number;
}): void {
  workers.set(worker.id, { ...worker, carrying: null, command: { type: "idle" } });
}

// Crit 10: registers a colony created outside the simulation (createColony()
// inserts it straight into SQLite). Without this, nestPositions wouldn't know
// where a freshly-minted colony's queen is until the next full
// loadSimulation() (i.e. restart) — a brand-new session's worker could never
// resolve a "return" command target in the meantime. Mirrors registerWorker
// above for the same reason.
export function registerColony(colonyId: number, queenX: number, queenY: number): void {
  nestPositions.set(colonyId, { x: queenX, y: queenY });
}

export function getWorkersForColony(
  colonyId: number,
): { id: number; x: number; y: number; carrying: Carrying; health: number; maxHealth: number }[] {
  return [...workers.values()]
    .filter((w) => w.colonyId === colonyId)
    .sort((a, b) => a.id - b.id)
    .map(({ id, x, y, carrying, health, maxHealth }) => ({ id, x, y, carrying, health, maxHealth }));
}

// Multiplayer visibility fix: the shared world has exactly one population of
// workers, and every colony's workers are visible to every other colony (only
// *commanding* them is restricted — see the ownership check below). Returns
// every worker NOT belonging to `colonyId`, tagged with its own colonyId so
// the client can render it distinctly and never mistake it for a controllable
// worker. Deliberately a separate function/field from getWorkersForColony
// (consumed as ColonyState.otherWorkers, not merged into `workers`) so the
// existing "workers = my own colony" contract — and everything that already
// relies on it, selection/hit-testing included — stays exactly as it was.
export function getWorkersExcludingColony(
  colonyId: number,
): { id: number; colonyId: number; x: number; y: number; carrying: Carrying; health: number; maxHealth: number }[] {
  return [...workers.values()]
    .filter((w) => w.colonyId !== colonyId)
    .sort((a, b) => a.id - b.id)
    .map(({ id, colonyId, x, y, carrying, health, maxHealth }) => ({ id, colonyId, x, y, carrying, health, maxHealth }));
}

export function getWorkerCommand(workerId: number): "idle" | "move" | "gather" | "return" | "attack" {
  const worker = workers.get(workerId);
  if (!worker) throw new Error(`no such worker: ${workerId}`);
  return worker.command.type;
}

// Stage 7: mirrors getWorkerCommand — the test entry point for introspecting
// a creature's AI state (idle/wander/chase) without exposing the whole
// CreatureCommand union on getCreaturesForWorld's public shape.
export function getCreatureCommand(creatureId: number): "idle" | "wander" | "chase" {
  const creature = creatures.get(creatureId);
  if (!creature) throw new Error(`no such creature: ${creatureId}`);
  return creature.command.type;
}

// Stage 7: the live worker id a spider is currently chasing, or null if it
// isn't chasing anyone — lets tests assert deterministic target selection
// (nearest, ascending-id tiebreak) directly rather than inferring it from
// movement alone.
export function getCreatureChaseTarget(creatureId: number): number | null {
  const creature = creatures.get(creatureId);
  if (!creature) throw new Error(`no such creature: ${creatureId}`);
  return creature.command.type === "chase" ? creature.command.targetWorkerId : null;
}

// Crit 10: `ownerColonyId` is the caller's own colony, resolved server-side
// from their session — never a client-supplied value. A worker that exists
// but belongs to someone else's colony is reported identically to a
// nonexistent one ("no such worker"): from the actor's perspective a
// wrong-owner id must behave exactly like a wrong id, never leak that the
// target exists under another colony. See CLAUDE.md's Crit 10 section.
export function issueMoveCommand(
  workerId: number,
  x: number,
  y: number,
  ownerColonyId: number,
): MoveCommandError | null {
  const worker = workers.get(workerId);
  if (!worker || worker.colonyId !== ownerColonyId) return "no such worker";
  if (worker.carrying) return "worker is busy returning resources";
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
//
// A worker already carrying a payload rejects this — Stage 4 commits a
// carrying worker to returning home; a move/gather command targeting it
// must not silently replace or destroy an in-flight payload. Gated on
// `worker.carrying`, not on `command.type === "return"`: carrying is the
// actual economic-ownership flag, even though the two are always set
// together. See CLAUDE.md.
export function issueGatherCommand(
  workerId: number,
  resourceId: number,
  ownerColonyId: number,
): GatherCommandError | null {
  const worker = workers.get(workerId);
  if (!worker || worker.colonyId !== ownerColonyId) return "no such worker";
  if (worker.carrying) return "worker is busy returning resources";
  const node = db.prepare("SELECT x, y FROM resource_nodes WHERE id = ?").get(resourceId) as
    | { x: number; y: number }
    | undefined;
  if (!node) return "no such resource node";
  worker.command = { type: "gather", resourceId, lastKnownX: node.x, lastKnownY: node.y };
  return null;
}

// Stage 6: same batch-command contract as move/gather (per-id errors, no
// cross-worker effects). A carrying worker is rejected exactly like
// move/gather — committed to returning home, not available to be
// redirected mid-carry. `cooldownRemaining: 0` lets a freshly issued attack
// land a hit the instant it's in range, rather than forcing a full
// cooldown wait first.
export function issueAttackCommand(
  workerId: number,
  creatureId: number,
  ownerColonyId: number,
): AttackCommandError | null {
  const worker = workers.get(workerId);
  if (!worker || worker.colonyId !== ownerColonyId) return "no such worker";
  if (worker.carrying) return "worker is busy returning resources";
  if (!creatures.has(creatureId)) return "no such creature";
  worker.command = { type: "attack", creatureId, cooldownRemaining: 0 };
  return null;
}

// Stage 3: a group move's clicked point is the centre of a loose destination
// area, not a shared exact target — this computes each worker's own nearby
// slot. A lone worker always gets the exact centre, untouched (no clamping
// either), so a solo move's existing bounds-validation behaviour in
// issueMoveCommand is completely unchanged. See CLAUDE.md.

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
//
// Stage 4: a successful claim no longer credits the colony — it picks the
// payload up into worker.carrying instead, and the colony isn't credited
// until a later, separate deposit (see attemptDeposit). Node depletion and
// the carrying write happen in one transaction, so "node depleted, then
// crash before the carrying write lands" can never lose the payload. Returns
// whether a claim was actually made, so the caller can decide the worker's
// next command (return vs. demote to idle).
function attemptGatherClaim(worker: SimWorker, resourceId: number): boolean {
  const node = findResourceNode(resourceId);
  if (!node) return false; // already claimed/depleted by someone else this tick
  const renewable = node.resourceType in RESOURCE_REGEN_RATES;

  if (node.amount !== null && node.amount <= 0) {
    // Renewable: stays present at 0 so it can regenerate (see
    // advanceResourceRegen) — nothing to claim yet, but not deleted.
    // Non-renewable: depletion is permanent, same as before Stage 5.
    if (!renewable) {
      db.prepare("DELETE FROM resource_nodes WHERE id = ?").run(resourceId);
      dirty = true;
    }
    return false;
  }

  const claimedAmount = node.amount === null ? GATHER_YIELD : Math.min(GATHER_YIELD, node.amount);
  const tx = db.transaction(() => {
    if (node.amount !== null) {
      const remaining = node.amount - claimedAmount;
      if (remaining <= 0 && !renewable) {
        db.prepare("DELETE FROM resource_nodes WHERE id = ?").run(resourceId);
      } else {
        db.prepare("UPDATE resource_nodes SET amount = ? WHERE id = ?").run(Math.max(remaining, 0), resourceId);
      }
    }
    db.prepare("UPDATE workers SET carrying_type = ?, carrying_amount = ? WHERE id = ?").run(
      node.resourceType,
      claimedAmount,
      worker.id,
    );
  });
  tx();
  worker.carrying = { resourceType: node.resourceType, amount: claimedAmount };
  dirty = true;
  return true;
}

// The deposit: colony credit and clearing the worker's carrying land in one
// transaction, so "colony credited, then crash before carrying clears" can
// never cause a double-deposit on reload (loadSimulation would otherwise see
// carrying still set and re-issue a return). See CLAUDE.md.
function attemptDeposit(worker: SimWorker): void {
  if (!worker.carrying) {
    worker.command = { type: "idle" }; // defensive; not reachable via normal play
    return;
  }
  const { resourceType, amount } = worker.carrying;
  const tx = db.transaction(() => {
    creditColony(worker.colonyId, resourceType, amount);
    db.prepare("UPDATE workers SET carrying_type = NULL, carrying_amount = NULL WHERE id = ?").run(worker.id);
  });
  tx();
  worker.carrying = null;
  worker.command = { type: "idle" };
  dirty = true;
}

// Stage 6: health is written synchronously on every hit (not batched into
// the periodic checkpoint) — same durability-on-mutation precedent as
// attemptGatherClaim/attemptDeposit's own transactions, just a plain UPDATE
// since there's nothing else to keep atomic with it until death.
function applyDamage(creature: SimCreature, amount: number): void {
  creature.health = Math.max(0, creature.health - amount);
  db.prepare("UPDATE creatures SET health = ? WHERE id = ?").run(creature.health, creature.id);
  dirty = true;
  if (creature.health <= 0) killCreature(creature);
}

// Death and carcass creation commit in one SQLite transaction (§7): a crash
// mid-kill can never leave an orphaned creature row or a missing/duplicate
// carcass. In-memory cleanup (creatures.delete, attacker idle-sweep) only
// happens after tx() returns, keeping in-memory state synced to the
// committed result. Carcass is inserted with kind='item' — protein has no
// entry in RESOURCE_REGEN_RATES, so attemptGatherClaim's existing
// non-renewable branch already makes it finite and delete-at-zero with no
// further code. See CLAUDE.md.
function killCreature(creature: SimCreature): void {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM creatures WHERE id = ?").run(creature.id);
    db.prepare(
      "INSERT INTO resource_nodes (world_id, x, y, resource_type, amount, max_amount, kind) " +
        "VALUES (?, ?, ?, 'protein', ?, ?, 'item')",
    ).run(creature.worldId, creature.x, creature.y, APHID_PROTEIN_VALUE, APHID_PROTEIN_VALUE);
  });
  tx();
  creatures.delete(creature.id);
  // Post-kill (§10): every worker attacking this creature goes idle in
  // place — no auto-gather of the new carcass, no auto-retarget to another
  // creature. The player must issue both explicitly.
  for (const worker of workers.values()) {
    if (worker.command.type === "attack" && worker.command.creatureId === creature.id) {
      worker.command = { type: "idle" };
    }
  }
  dirty = true;
}

// Stage 7: worker death. A single DELETE is enough — no transaction, unlike
// killCreature's carcass-insert — because there's nothing else to keep
// atomic with it (no worker carcass; see the carried-resource rule below).
// Deleting the row deletes carrying_type/carrying_amount with it: whatever
// payload the worker held is simply gone, and because the row no longer
// exists, nothing can ever later run attemptDeposit for this worker id. This
// is the entire carried-resource-on-death rule — no separate code path, so
// nothing can duplicate or re-credit it. See CLAUDE.md.
function killWorker(worker: SimWorker, cause: string, creatureId?: number): void {
  db.prepare("DELETE FROM workers WHERE id = ?").run(worker.id);
  workers.delete(worker.id);
  // Mirrors killCreature's attacker-idle-sweep for the reverse direction:
  // any spider mid-chase of this now-dead worker drops to idle rather than
  // holding a dangling targetWorkerId. advanceCreatures processes
  // creatures.values() in one single-threaded pass, so a spider reached
  // later in the same tick already sees this sweep's effect.
  for (const creature of creatures.values()) {
    if (creature.command.type === "chase" && creature.command.targetWorkerId === worker.id) {
      creature.command = { type: "idle", remaining: pickIdleDuration(creature, WANDER_PARAMS[creature.species]) };
    }
  }
  dirty = true;
  logAction(worker.colonyId, "worker_died", { workerId: worker.id, cause, creatureId });
}

// Mirrors applyDamage: health is written synchronously on every hit, same
// durability-on-mutation precedent. Id-based (not a live-object param, unlike
// internal killWorker) so this doubles as the test entry point, exactly the
// same role issueAttackCommand plays for creature combat — callers (future
// advanceSpider, and tests) never need to hold a live SimWorker reference. A
// no-op if the worker is already gone, mirroring handleAttackCommand's "no
// such creature" guard for the symmetric case.
export function applyDamageToWorker(workerId: number, amount: number, spiderId: number): void {
  const worker = workers.get(workerId);
  if (!worker) return;
  worker.health = Math.max(0, worker.health - amount);
  db.prepare("UPDATE workers SET health = ? WHERE id = ?").run(worker.health, worker.id);
  dirty = true;
  if (worker.health <= 0) killWorker(worker, "spider", spiderId);
}

// Stage 6: chase + attack resolution. Unlike move/gather/return, "in range"
// here is a continuous check, never a one-shot arrival — the target keeps
// moving and the attack never "completes" — so this gets its own branch
// rather than being forced into resolveTarget/resolveArrival. Always reads
// the creature's *current* position (never a captured lastKnownX/Y), so a
// wandering target is chased live every tick.
function handleAttackCommand(
  worker: SimWorker,
  command: Extract<WorkerCommand, { type: "attack" }>,
  separation: { dx: number; dy: number },
  dt: number,
): void {
  const creature = creatures.get(command.creatureId);
  if (!creature) {
    worker.command = { type: "idle" };
    return;
  }

  const dx = creature.x - worker.x;
  const dy = creature.y - worker.y;
  const dist = Math.hypot(dx, dy);

  if (dist > WORKER_ATTACK_RANGE) {
    const step = Math.min(WORKER_SPEED * dt, dist - WORKER_ATTACK_RANGE + ARRIVAL_EPSILON);
    worker.x = clamp(worker.x + (dx / dist) * step + separation.dx, 0, worldBounds.width);
    worker.y = clamp(worker.y + (dy / dist) * step + separation.dy, 0, worldBounds.height);
  } else {
    // Already in range: still take the separation nudge so multiple
    // attackers on the same creature don't stack on top of each other.
    worker.x = clamp(worker.x + separation.dx, 0, worldBounds.width);
    worker.y = clamp(worker.y + separation.dy, 0, worldBounds.height);
  }
  dirty = true;

  const cooldownRemaining = Math.max(0, command.cooldownRemaining - dt);
  if (dist <= WORKER_ATTACK_RANGE && cooldownRemaining <= 0) {
    applyDamage(creature, WORKER_ATTACK_DAMAGE);
    // killCreature (inside applyDamage) may already have reset this worker
    // to idle if that hit was lethal — only write the cooldown back if the
    // command is still "attack".
    if (worker.command.type === "attack") {
      worker.command = { ...worker.command, cooldownRemaining: WORKER_ATTACK_COOLDOWN };
    }
  } else if (worker.command.type === "attack") {
    worker.command = { ...worker.command, cooldownRemaining };
  }
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

// Resolves what a command is currently heading toward and how close counts
// as arrival. `return`'s target is the worker's own colony's nest, read from
// the immutable nestPositions cache — no query needed on every tick.
function resolveTarget(
  worker: SimWorker,
  command: WorkerCommand,
): { x: number; y: number; arrivalRange: number } {
  if (command.type === "move") return { x: command.targetX, y: command.targetY, arrivalRange: 0 };
  if (command.type === "gather") {
    return { x: command.lastKnownX, y: command.lastKnownY, arrivalRange: GATHER_RANGE };
  }
  // command.type === "return"
  const nest = nestPositions.get(worker.colonyId)!;
  return { x: nest.x, y: nest.y, arrivalRange: DEPOSIT_RANGE };
}

// Resolves what happens the instant a worker reaches its command's target.
// A `gather` arrival attempts a claim and then either becomes a `return`
// (claim succeeded) or demotes to `idle` (someone else claimed it first,
// in this very tick, since arrival-range workers' claims are resolved in
// Map-iteration order). A `return` arrival deposits and sets its own next
// command (idle). Note: a claim that happens to land within DEPOSIT_RANGE of
// the queen is never deposited in the same tick — this only converts
// gather -> return, mirroring how gather -> move demotion above also never
// re-checks arrival same-tick. See CLAUDE.md.
function resolveArrival(worker: SimWorker, command: WorkerCommand): void {
  if (command.type === "gather") {
    worker.command = attemptGatherClaim(worker, command.resourceId) ? { type: "return" } : { type: "idle" };
    return;
  }
  if (command.type === "return") {
    attemptDeposit(worker); // sets worker.command itself
    return;
  }
  worker.command = { type: "idle" }; // move arrival
}

// The only mutation path for position and resource claims: synchronous, no
// await, so neither can ever interleave with an HTTP handler's own
// synchronous mutation, nor with each other across workers in the same tick
// (the same single-process guarantee Crit 9 relies on for reproduce()).
//
// `gather`, `return`, and `move` commands all reuse the exact same
// step-toward-target movement — the only differences are the arrival
// distance (resolveTarget) and what happens on arrival (resolveArrival).
// There is deliberately only one movement implementation, which is also why
// a returning worker keeps participating in separation exactly like any
// other command (requirement 10) with no special-casing needed.
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
  advanceResourceRegen(dt);
  advanceCreatures(dt);

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

    if (worker.command.type === "attack") {
      handleAttackCommand(worker, worker.command, separation, dt);
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
    const { x: targetX, y: targetY, arrivalRange } = resolveTarget(worker, command);

    const dx = targetX - worker.x;
    const dy = targetY - worker.y;
    const dist = Math.hypot(dx, dy);

    if (dist <= arrivalRange + ARRIVAL_EPSILON) {
      resolveArrival(worker, command);
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
      resolveArrival(worker, command);
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
// written: only position is durable (see CLAUDE.md). Carrying is
// deliberately NOT flushed here — it's already made durable the instant it
// changes, inside attemptGatherClaim/attemptDeposit's own transactions, so
// there is nothing left for the periodic checkpoint to do for it. Don't
// "fix" that by adding carrying columns to the UPDATE below.
export function checkpointSimulation(): void {
  const update = db.prepare("UPDATE workers SET x = ?, y = ? WHERE id = ?");
  const updateCreature = db.prepare("UPDATE creatures SET x = ?, y = ? WHERE id = ?");
  const tx = db.transaction((workerList: SimWorker[], creatureList: SimCreature[]) => {
    for (const w of workerList) update.run(w.x, w.y, w.id);
    for (const c of creatureList) updateCreature.run(c.x, c.y, c.id);
  });
  tx([...workers.values()], [...creatures.values()]);
}

loadSimulation();
