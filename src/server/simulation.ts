import {
  APHID_IDLE_MAX,
  APHID_IDLE_MIN,
  APHID_SPEED,
  APHID_WANDER_RADIUS,
  type Caste,
  CASTE_BASE_STATS,
  CREATURE_PROTEIN_VALUE,
  DEPOSIT_RANGE,
  GATHER_DURATION,
  GATHER_RANGE,
  GOLDEN_ANGLE,
  GROUP_DESTINATION_SPACING,
  MIN_SEPARATION,
  QUEEN_AGGRO_RANGE,
  QUEEN_DISENGAGE_RANGE,
  QUEEN_REGEN_DELAY,
  QUEEN_REGEN_RATE,
  SEPARATION_STRENGTH,
  SPIDER_AGGRO_RANGE,
  SPIDER_ATTACK_COOLDOWN,
  SPIDER_ATTACK_DAMAGE,
  SPIDER_ATTACK_RANGE,
  SPIDER_CLEAR_RADIUS,
  SPIDER_DISENGAGE_RANGE,
  SPIDER_IDLE_MAX,
  SPIDER_IDLE_MIN,
  SPIDER_SPEED,
  SPIDER_WANDER_RADIUS,
  WORKER_ATTACK_COOLDOWN,
  WORKER_ATTACK_RANGE,
} from "./balance.ts";
import { db } from "./db.ts";
import { type EvolutionChoice, type EvolutionSelections, getEvolutionModifiers, NO_EVOLUTION } from "./evolution.ts";
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
  // Stage 9: channelRemaining is absent while still traveling to the node,
  // and set the instant arrival happens (resolveArrival) — a short in-memory
  // timer, same idiom as attack's cooldownRemaining, never persisted. Once
  // it ticks to zero the existing attemptGatherClaim runs exactly as before.
  // See CLAUDE.md's Stage 9 section for why this exists at all.
  | { type: "gather"; resourceId: number; lastKnownX: number; lastKnownY: number; channelRemaining?: number }
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
  // Stage 10: durable, set once at insert (spawnStartingWorkers/reproduce)
  // and never changed thereafter — there's no caste-respec mechanic. See
  // CLAUDE.md's Stage 10 section.
  caste: Caste;
}

export type MoveCommandError =
  | "no such worker"
  | "invalid coordinates"
  | "coordinates out of bounds"
  | "worker is busy returning resources"
  | "colony defeated";
export type GatherCommandError =
  | "no such worker"
  | "no such resource node"
  | "worker is busy returning resources"
  | "wrong caste"
  | "colony defeated";
export type AttackCommandError =
  | "no such worker"
  | "no such creature"
  | "worker is busy returning resources"
  | "colony defeated";

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
// Stage 8: chase-queen is a fourth ephemeral variant, additive alongside the
// existing worker-targeting "chase" — never a rename. Same live-lookup
// discipline: targetColonyId is looked up fresh in colonies.get() every
// tick, never a captured position.
type CreatureCommand =
  | { type: "idle"; remaining: number }
  | { type: "wander"; targetX: number; targetY: number }
  | { type: "chase"; targetWorkerId: number; cooldownRemaining: number }
  | { type: "chase-queen"; targetColonyId: number; cooldownRemaining: number };

const creatures = new Map<number, SimCreature>();

const workers = new Map<number, SimWorker>();
let worldBounds = { width: 0, height: 0 };

// Stage 8: replaces the old narrow nestPositions (Map<id,{x,y}>) with a full
// colony cache — adds durable health/maxHealth/status, plus an ephemeral
// timeSinceLastDamage that (like worker/creature wander state) resets on
// every loadSimulation() rather than surviving a restart, so a just-
// restarted queen simply waits out one more regen delay before healing,
// never an immediate burst. Position (x, y) is still treated as immutable
// for the life of the process — nothing ever updates queen_x/y after
// seeding, defeat included (a ruin keeps its original spot).
// Stage 9: peakPopulation and evolution are both durable (see db.ts's
// colonies columns) — loaded fresh in loadSimulation() like health/status
// above, never reset on a restart. peakPopulation only ever increases (see
// maybeUpdatePeakPopulation); evolution's three tier fields only ever move
// from null to a permanent choice (see applyEvolutionSelection). Neither is
// ever copied onto a different colony row — that's what keeps Start New
// Colony's replacement genuinely fresh. See CLAUDE.md's Stage 9 section.
// Stage 12: defeatedAt is the same durable defeated_at column defeatColony()
// already set — exposed here so ecology.ts's queen-exclusion check (which
// reads colonies.values(), not a fresh SQL query) and getAllColonies() can
// both drive "is this ruin still here" off one single field. Always null for
// an active colony.
interface SimColony {
  id: number;
  x: number;
  y: number;
  health: number;
  maxHealth: number;
  status: "active" | "defeated";
  timeSinceLastDamage: number;
  peakPopulation: number;
  evolution: EvolutionSelections;
  defeatedAt: string | null;
}

const colonies = new Map<number, SimColony>();
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

  colonies.clear();
  const colonyRows = db
    .prepare(
      "SELECT id, queen_x AS x, queen_y AS y, status, queen_health AS health, queen_max_health AS maxHealth, " +
        "peak_population AS peakPopulation, evolution_tier1 AS tier1, evolution_tier2 AS tier2, evolution_tier3 AS tier3, " +
        "defeated_at AS defeatedAt FROM colonies",
    )
    .all() as {
    id: number;
    x: number;
    y: number;
    status: string;
    health: number;
    maxHealth: number;
    peakPopulation: number | null;
    tier1: EvolutionChoice | null;
    tier2: EvolutionChoice | null;
    tier3: EvolutionChoice | null;
    defeatedAt: string | null;
  }[];
  for (const row of colonyRows) {
    colonies.set(row.id, {
      id: row.id,
      x: row.x,
      y: row.y,
      health: row.health,
      maxHealth: row.maxHealth,
      status: row.status === "defeated" ? "defeated" : "active",
      timeSinceLastDamage: 0,
      peakPopulation: row.peakPopulation ?? 0,
      evolution: { tier1: row.tier1, tier2: row.tier2, tier3: row.tier3 },
      defeatedAt: row.defeatedAt,
    });
  }

  workers.clear();
  // ORDER BY id makes Map insertion order (and therefore advanceSimulation's
  // iteration order) deterministic — load-bearing for contested resource
  // claims, where the worker processed first wins. See CLAUDE.md.
  const rows = db
    .prepare(
      "SELECT id, colony_id AS colonyId, x, y, carrying_type AS carryingType, carrying_amount AS carryingAmount, health, max_health AS maxHealth, caste FROM workers ORDER BY id",
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
    caste: Caste;
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
      caste: row.caste,
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

// Stage 7: a spider's ambient wander (never its chase) must not drift into a
// colony's spawn — nestPositions already holds every colony's queen position
// ever minted (registerColony() keeps it current, unbounded by
// SPAWN_ANCHOR_COUNT — colony 11, 20, etc. are in here too, not just the
// first 10 world-gen anchors), so checking against it protects every real
// colony, not just the ones buildWorldPopulation() knew about at world-gen
// time. Without this, an idle-wandering spider is a true unconstrained
// random walk (bounded only by world edges) and can eventually camp next to
// any colony's nest and kill its starting workers before they're ever
// claimed/used — a de facto colony elimination the brief explicitly
// excludes. Chasing is deliberately left unconstrained (advanceSpider's
// chase branch never calls this) — a spider pulled toward a nest by a
// worker that wandered out and is now fleeing home is legitimate predation,
// not ambient camping.
function isClearOfNests(x: number, y: number, clearRadius: number): boolean {
  for (const nest of colonies.values()) {
    if (nest.status !== "active") continue; // a ruin protects nothing
    if (Math.hypot(nest.x - x, nest.y - y) <= clearRadius) return false;
  }
  return true;
}

// A chase can legitimately leave a spider standing inside a nest's clear
// zone (e.g. its target fled home and disengaged there) — closest, not just
// any, so the escape step below always retreats from the immediate threat
// first if more than one zone overlaps.
function nearestViolatingNest(x: number, y: number, clearRadius: number): { x: number; y: number } | null {
  let nearest: { x: number; y: number } | null = null;
  let nearestDist = Infinity;
  for (const nest of colonies.values()) {
    if (nest.status !== "active") continue;
    const dist = Math.hypot(nest.x - x, nest.y - y);
    if (dist <= clearRadius && dist < nearestDist) {
      nearest = nest;
      nearestDist = dist;
    }
  }
  return nearest;
}

function pickWanderTarget(
  creature: SimCreature,
  params: { wanderRadius: number },
): { x: number; y: number } {
  if (creature.species === "spider") {
    // Already inside a clear zone (only reachable via a chase that just
    // ended there — initial seeding and every prior wander step already
    // keep spiders out). Step straight away from the nearest violator
    // instead of drawing a random angle: a plain rejection-sample-and-give-
    // up-to-"hold position" here would let the spider camp permanently
    // right next to the nest (every random draw re-rejected forever), which
    // is worse than the bug this exists to fix — a stationary spider beside
    // a colony's spawn can still pick off every worker that starts there.
    // This instead guarantees monotonic progress out of the zone over a
    // bounded number of wander cycles (no RNG draw needed, so it can't fail).
    const violator = nearestViolatingNest(creature.x, creature.y, SPIDER_CLEAR_RADIUS);
    if (violator) {
      const dx = creature.x - violator.x;
      const dy = creature.y - violator.y;
      const dist = Math.hypot(dx, dy) || 1;
      return {
        x: clamp(creature.x + (dx / dist) * params.wanderRadius, 0, worldBounds.width),
        y: clamp(creature.y + (dy / dist) * params.wanderRadius, 0, worldBounds.height),
      };
    }
    // Not currently inside any zone — bounded rejection sampling (same idiom
    // as balance.ts's placeScattered()) keeps a normal wander step from
    // drawing a target that would enter one. If every draw is rejected,
    // hold position for this cycle; the next idle cycle tries fresh RNG
    // state, and since the spider isn't inside a zone to begin with, holding
    // still can't cause the camping problem the branch above exists for.
    for (let attempt = 0; attempt < 20; attempt++) {
      const angle = nextRandom(creature) * Math.PI * 2;
      const dist = nextRandom(creature) * params.wanderRadius;
      const target = {
        x: clamp(creature.x + Math.cos(angle) * dist, 0, worldBounds.width),
        y: clamp(creature.y + Math.sin(angle) * dist, 0, worldBounds.height),
      };
      if (isClearOfNests(target.x, target.y, SPIDER_CLEAR_RADIUS)) return target;
    }
    return { x: creature.x, y: creature.y };
  }

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
// a fresh loadSimulation() happens to iterate ascending).
//
// Stage 8: only if that scan finds no worker does a second, queen-aggro scan
// run (§7's required priority: nearest worker first, queen only as a
// fallback). The queen scan deliberately applies no isClearOfNests gate —
// unlike the worker scan above, which exists to keep a spider's *ambient
// wander* out of a nest's safe zone. A spider can only ever end up near a
// queen in the first place by having wandered or chased its way inside that
// zone (see isClearOfNests' doc comment) — by construction, not by a special
// distance check, so a queen is "noticed" only as the natural result of
// already being close, never from across the map. Ownership plays no part in
// either scan — ownership must not affect targeting (§7).
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

  if (command.type === "chase-queen") {
    // Live lookup every tick, same discipline as "chase" above. A queen that
    // no longer exists or is no longer active (just died, or this is a stale
    // command surviving past a defeat somehow) means drop to idle
    // immediately — a ruin is never a valid target, and a spider never
    // attacks a dead queen (§28).
    const target = colonies.get(command.targetColonyId);
    if (!target || target.status !== "active") {
      spider.command = { type: "idle", remaining: pickIdleDuration(spider, WANDER_PARAMS.spider) };
      return;
    }

    const dx = target.x - spider.x;
    const dy = target.y - spider.y;
    const dist = Math.hypot(dx, dy);

    if (dist > QUEEN_DISENGAGE_RANGE) {
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
      applyDamageToQueen(target.id, SPIDER_ATTACK_DAMAGE, spider.id);
      // applyDamageToQueen's defeatColony sweep may already have reset this
      // spider to idle if that hit was lethal — only write the cooldown
      // back if the command is still "chase-queen".
      if (spider.command.type === "chase-queen") {
        spider.command = { ...spider.command, cooldownRemaining: SPIDER_ATTACK_COOLDOWN };
      }
    } else if (spider.command.type === "chase-queen") {
      spider.command = { ...spider.command, cooldownRemaining };
    }
    return;
  }

  let nearest: SimWorker | null = null;
  let nearestDist = Infinity;
  for (const worker of workers.values()) {
    // A straight-line wander step between two points that are each clear of
    // every nest can still pass through a nest's clear zone in between (the
    // exclusion in pickWanderTarget only constrains the chosen endpoints,
    // not the path) — so a spider can end up physically close enough to
    // aggro a worker standing at/near a nest even though it was never
    // "supposed" to be there. Skipping any worker who is themselves inside
    // a clear zone closes that gap directly, at the one point that actually
    // matters (the aggro trigger), rather than chasing every possible path
    // the spider's position could take to get near one. This also means a
    // worker idling at its own queen is never aggro'd from a distance —
    // acceptable (even desirable) as a small safe zone around home, and
    // consistent with keeping seeded/wandering spiders out of the same
    // radius in the first place. A chase already in progress still ignores
    // this (unconstrained on purpose, see advanceSpider's chase branch) —
    // this only gates the initial aggro pick.
    if (!isClearOfNests(worker.x, worker.y, SPIDER_CLEAR_RADIUS)) continue;
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

  // Queen-aggro fallback (§7): only reached when no worker qualified above.
  // Nearest-then-colony-id tie-break, deliberately no isClearOfNests gate —
  // see the function-level doc comment.
  let nearestQueen: SimColony | null = null;
  let nearestQueenDist = Infinity;
  for (const colony of colonies.values()) {
    if (colony.status !== "active") continue;
    const dist = Math.hypot(colony.x - spider.x, colony.y - spider.y);
    if (dist > QUEEN_AGGRO_RANGE) continue;
    if (dist < nearestQueenDist || (dist === nearestQueenDist && nearestQueen !== null && colony.id < nearestQueen.id)) {
      nearestQueen = colony;
      nearestQueenDist = dist;
    }
  }
  if (nearestQueen) {
    spider.command = { type: "chase-queen", targetColonyId: nearestQueen.id, cooldownRemaining: 0 };
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
  caste: Caste;
}): void {
  workers.set(worker.id, { ...worker, carrying: null, command: { type: "idle" } });
}

// Crit 10: registers a colony created outside the simulation (createColony()
// inserts it straight into SQLite). Without this, the in-memory colonies
// cache wouldn't know where a freshly-minted colony's queen is until the
// next full loadSimulation() (i.e. restart) — a brand-new session's worker
// could never resolve a "return" command target in the meantime. Mirrors
// registerWorker above for the same reason. Stage 8: every freshly minted
// colony starts active at full health — see db.ts's createColony(), which
// always inserts the same values this is called with.
// Stage 9: startingPopulation seeds peakPopulation (a fresh colony's peak is
// always its own starting worker count — never 0, never inherited from
// anywhere else), and evolution always starts at NO_EVOLUTION — there is no
// code path that copies a tier selection from one colony row to another, so
// every freshly minted colony (including Start New Colony's replacement and
// spare colonies) genuinely starts evolutionarily blank. See CLAUDE.md.
export function registerColony(
  colonyId: number,
  queenX: number,
  queenY: number,
  health: number,
  maxHealth: number,
  startingPopulation: number,
): void {
  colonies.set(colonyId, {
    id: colonyId,
    x: queenX,
    y: queenY,
    health,
    maxHealth,
    status: "active",
    timeSinceLastDamage: 0,
    peakPopulation: startingPopulation,
    evolution: NO_EVOLUTION,
    defeatedAt: null,
  });
}

// Stage 12: registers a creature ecology.ts just spawned outside the
// simulation (a raw SQL insert into `creatures`). Mirrors registerWorker/
// registerColony above for the same reason — without this, a freshly
// ecology-spawned aphid/spider would be invisible to getState()/
// advanceCreatures() until the next full loadSimulation() (restart).
export function registerCreature(creature: {
  id: number;
  worldId: number;
  species: string;
  x: number;
  y: number;
  health: number;
  maxHealth: number;
}): void {
  creatures.set(creature.id, {
    ...creature,
    command: { type: "idle", remaining: WANDER_PARAMS[creature.species].idleMin },
    rngState: seedRng(creature.id),
  });
}

export function getWorkersForColony(
  colonyId: number,
): { id: number; x: number; y: number; carrying: Carrying; health: number; maxHealth: number; caste: Caste }[] {
  return [...workers.values()]
    .filter((w) => w.colonyId === colonyId)
    .sort((a, b) => a.id - b.id)
    .map(({ id, x, y, carrying, health, maxHealth, caste }) => ({ id, x, y, carrying, health, maxHealth, caste }));
}

// Stage 8: live spider positions, for sessions.ts to fold into createColony()'s
// `avoid` list when picking a Start New Colony spawn point — a fresh queen
// must not spawn on top of a wandering predator. Positions only (no id/health)
// since this is purely a collision-avoidance input, not a public API.
export function getSpiderPositions(): { x: number; y: number }[] {
  return [...creatures.values()].filter((c) => c.species === "spider").map(({ x, y }) => ({ x, y }));
}

// Stage 12: live worker positions, for ecology.ts's physical-clearance check
// (a candidate spawn point must not land directly on top of a unit) — purely
// a collision-avoidance input, not a public API, same shape/purpose as
// getSpiderPositions above.
export function getAllWorkerPositions(): { x: number; y: number }[] {
  return [...workers.values()].map(({ x, y }) => ({ x, y }));
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
): {
  id: number;
  colonyId: number;
  x: number;
  y: number;
  carrying: Carrying;
  health: number;
  maxHealth: number;
  caste: Caste;
}[] {
  return [...workers.values()]
    .filter((w) => w.colonyId !== colonyId)
    .sort((a, b) => a.id - b.id)
    .map(({ id, colonyId, x, y, carrying, health, maxHealth, caste }) => ({
      id,
      colonyId,
      x,
      y,
      carrying,
      health,
      maxHealth,
      caste,
    }));
}

// Stage 12.5B: every worker across every colony, tagged by colonyId — the
// admin world-monitor's opt-in Units layer. No existing accessor returns
// "all workers regardless of colony" (getWorkersForColony is scoped to one
// colony, getWorkersExcludingColony deliberately omits one, getAllWorkerPositions
// strips everything but x/y for ecology's collision check) so this is a new,
// narrow, read-only addition — never referenced by any gameplay command path.
export function getAllWorkersWithColony(): {
  id: number;
  colonyId: number;
  x: number;
  y: number;
  caste: Caste;
  health: number;
  maxHealth: number;
}[] {
  return [...workers.values()]
    .sort((a, b) => a.id - b.id)
    .map(({ id, colonyId, x, y, caste, health, maxHealth }) => ({ id, colonyId, x, y, caste, health, maxHealth }));
}

export function getWorkerCommand(workerId: number): "idle" | "move" | "gather" | "return" | "attack" {
  const worker = workers.get(workerId);
  if (!worker) throw new Error(`no such worker: ${workerId}`);
  return worker.command.type;
}

// Stage 7: mirrors getWorkerCommand — the test entry point for introspecting
// a creature's AI state (idle/wander/chase) without exposing the whole
// CreatureCommand union on getCreaturesForWorld's public shape. Stage 8 adds
// "chase-queen" as a fourth possible value, purely additive.
export function getCreatureCommand(creatureId: number): "idle" | "wander" | "chase" | "chase-queen" {
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

// Stage 8: the live colony id a spider is currently chasing as a queen
// target, or null — the chase-queen counterpart to getCreatureChaseTarget.
export function getCreatureChaseQueenTarget(creatureId: number): number | null {
  const creature = creatures.get(creatureId);
  if (!creature) throw new Error(`no such creature: ${creatureId}`);
  return creature.command.type === "chase-queen" ? creature.command.targetColonyId : null;
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
  // Stage 8: checked before any worker lookup — a defeated colony has no
  // workers left anyway, but authorization must come from lifecycle status
  // itself, not incidentally fall out of "no workers to find" (see §23).
  if (!isColonyActive(ownerColonyId)) return "colony defeated";
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
  if (!isColonyActive(ownerColonyId)) return "colony defeated";
  const worker = workers.get(workerId);
  if (!worker || worker.colonyId !== ownerColonyId) return "no such worker";
  if (worker.carrying) return "worker is busy returning resources";
  // Stage 10: Soldier is structurally barred from gathering/carrying — a
  // combat specialist, not a laborer. Checked before the DB hit, cheapest
  // rejection first.
  if (worker.caste === "soldier") return "wrong caste";
  // Stage 9: a worker already gathering this exact node — whether still
  // travelling or mid-channel — is a no-op, not a redirect. Without this, a
  // redundant re-send (a client poll loop, or a player clicking the same
  // node twice) would stomp an in-progress gather command and, worse, wipe
  // out a live `channelRemaining` countdown (resolveArrival), restarting
  // Foraging II's channel from full duration every time and potentially
  // never letting it reach zero. A redirect to a *different* resourceId
  // still works exactly as before — only an identical resourceId is treated
  // as "already doing this."
  if (worker.command.type === "gather" && worker.command.resourceId === resourceId) return null;
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
  if (!isColonyActive(ownerColonyId)) return "colony defeated";
  const worker = workers.get(workerId);
  if (!worker || worker.colonyId !== ownerColonyId) return "no such worker";
  if (worker.carrying) return "worker is busy returning resources";
  const creature = creatures.get(creatureId);
  if (!creature) return "no such creature";
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

function findResourceNode(id: number): { resourceType: string; amount: number } | undefined {
  return db.prepare("SELECT resource_type AS resourceType, amount FROM resource_nodes WHERE id = ?").get(id) as
    | { resourceType: string; amount: number }
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

  if (node.amount <= 0) {
    // Stage 12.5: every natural node is finite and never refills in place —
    // a node found at zero (another worker claimed the last of it this tick)
    // is permanently gone. World-level renewal comes only from ecology
    // spawning a brand new node elsewhere (see ecology.ts) — never from this
    // node coming back. See CLAUDE.md's Stage 12.5 correction.
    db.prepare("DELETE FROM resource_nodes WHERE id = ?").run(resourceId);
    dirty = true;
    return false;
  }

  // Stage 9 Foraging I: a colony's effective carry yield substitutes for the
  // flat per-caste base here — the node-depletion math and the "claim is
  // always capped at what's actually left" invariant below are completely
  // untouched, since the claim is still read fresh inside this same
  // transaction. Stage 10: carryYield is also caste-dependent (see
  // CASTE_BASE_STATS). See CLAUDE.md's Stage 9/10 sections.
  const colony = colonies.get(worker.colonyId);
  const carryYield = colony
    ? getEvolutionModifiers(colony.evolution, worker.caste).carryYield
    : CASTE_BASE_STATS[worker.caste].carryCapacity;
  // Stage 12: every resource is finite by construction now, so a claim is
  // always capped at what's actually on the node — no infinite-gather path.
  const claimedAmount = Math.min(carryYield, node.amount);
  const tx = db.transaction(() => {
    const remaining = node.amount - claimedAmount;
    if (remaining <= 0) {
      db.prepare("DELETE FROM resource_nodes WHERE id = ?").run(resourceId);
    } else {
      db.prepare("UPDATE resource_nodes SET amount = ? WHERE id = ?").run(remaining, resourceId);
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
// since there's nothing else to keep atomic with it until death. Returns the
// new carcass's resource-node id if this hit was lethal, else null — lets
// callers (handleAttackCommand) log which carcass a kill produced.
function applyDamage(creature: SimCreature, amount: number): number | null {
  creature.health = Math.max(0, creature.health - amount);
  db.prepare("UPDATE creatures SET health = ? WHERE id = ?").run(creature.health, creature.id);
  dirty = true;
  return creature.health <= 0 ? killCreature(creature) : null;
}

// Death and carcass creation commit in one SQLite transaction (§7): a crash
// mid-kill can never leave an orphaned creature row or a missing/duplicate
// carcass. In-memory cleanup (creatures.delete, attacker idle-sweep) only
// happens after tx() returns, keeping in-memory state synced to the
// committed result. Carcass is inserted with kind='item' — every node is
// finite and delete-at-zero (see attemptGatherClaim), so a carcass needs no
// special-case code of its own. Loot is looked up per species
// (CREATURE_PROTEIN_VALUE), generalized in Stage 7 from what used to be a
// hardcoded APHID_PROTEIN_VALUE. Returns the new carcass's resource-node id.
// See CLAUDE.md.
function killCreature(creature: SimCreature): number {
  const proteinValue = CREATURE_PROTEIN_VALUE[creature.species];
  let carcassId!: number;
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM creatures WHERE id = ?").run(creature.id);
    const info = db
      .prepare(
        "INSERT INTO resource_nodes (world_id, x, y, resource_type, amount, max_amount, kind) " +
          "VALUES (?, ?, ?, 'protein', ?, ?, 'item')",
      )
      .run(creature.worldId, creature.x, creature.y, proteinValue, proteinValue);
    carcassId = Number(info.lastInsertRowid);
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
  return carcassId;
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

export function isColonyActive(colonyId: number): boolean {
  return colonies.get(colonyId)?.status === "active";
}

// Stage 8: state.ts's two colony-shaped reads — one colony's own full
// in-memory snapshot (health reflects any not-yet-checkpointed regen, unlike
// a raw SQL read) and the shared, public roster every session sees. Both
// read from the same `colonies` Map that authorization/combat already treat
// as authoritative, so the client's queen health bar/ruin styling can never
// show a value that's behind what issueMoveCommand etc. are enforcing
// against.
export function getColonySnapshot(colonyId: number):
  | {
      id: number;
      x: number;
      y: number;
      health: number;
      maxHealth: number;
      status: "active" | "defeated";
      peakPopulation: number;
      evolution: EvolutionSelections;
    }
  | undefined {
  const colony = colonies.get(colonyId);
  if (!colony) return undefined;
  const { id, x, y, health, maxHealth, status, peakPopulation, evolution } = colony;
  return { id, x, y, health, maxHealth, status, peakPopulation, evolution };
}

// Stage 9: actions.ts's reproduce()/selectEvolution() need just the three
// tier selections (not the whole position/health snapshot above) to compute
// modifiers and check eligibility — a small, purpose-built accessor rather
// than making every caller destructure getColonySnapshot's larger shape.
export function getColonyEvolution(colonyId: number): EvolutionSelections | undefined {
  return colonies.get(colonyId)?.evolution;
}

export function getAllColonies(): {
  id: number;
  x: number;
  y: number;
  health: number;
  maxHealth: number;
  status: "active" | "defeated";
  population: number;
  peakPopulation: number;
  evolution: EvolutionSelections;
  defeatedAt: string | null;
}[] {
  return [...colonies.values()]
    .sort((a, b) => a.id - b.id)
    .map(({ id, x, y, health, maxHealth, status, peakPopulation, evolution, defeatedAt }) => ({
      id,
      x,
      y,
      health,
      maxHealth,
      status,
      population: getWorkersForColony(id).length,
      peakPopulation,
      evolution,
      defeatedAt,
    }));
}

// Stage 9: the only path that currently increases a colony's worker count
// (reproduce()) calls this immediately after registering the new worker.
// peakPopulation only ever moves upward — losing workers (death, defeat)
// never lowers it, which is exactly what makes tier eligibility permanent
// once reached (§3). A rare, discrete event, not a per-tick scan, so a
// synchronous write here is cheap and matches checkpointSimulation's own
// "synchronous for correctness-critical discrete events" discipline.
export function maybeUpdatePeakPopulation(colonyId: number): void {
  const colony = colonies.get(colonyId);
  if (!colony) return;
  const current = getWorkersForColony(colonyId).length;
  if (current <= colony.peakPopulation) return;
  colony.peakPopulation = current;
  db.prepare("UPDATE colonies SET peak_population = ? WHERE id = ?").run(current, colonyId);
}

// Stage 9: the single authoritative, idempotent mutator for a permanent
// evolution choice — mirrors defeatColony's `WHERE status = 'active'` guard
// exactly, just against a tier column instead: `result.changes === 0` means
// either the tier was already chosen or lost a race to a concurrent request,
// and either way nothing further happens. Exactly-once is enforced by
// SQLite itself, not by caller discipline (actions.ts's selectEvolution does
// its own cheap pre-checks for fast, friendly error messages, but the real
// guarantee lives here). See CLAUDE.md's Stage 9 section.
export function applyEvolutionSelection(colonyId: number, tier: 1 | 2 | 3, choice: EvolutionChoice): boolean {
  const column = `evolution_tier${tier}`;
  const result = db
    .prepare(`UPDATE colonies SET ${column} = ? WHERE id = ? AND ${column} IS NULL`)
    .run(choice, colonyId);
  if (result.changes === 0) return false;

  const colony = colonies.get(colonyId);
  if (!colony) return true; // DB updated; in-memory cache will catch up on next loadSimulation
  if (tier === 1) colony.evolution = { ...colony.evolution, tier1: choice };
  else if (tier === 2) colony.evolution = { ...colony.evolution, tier2: choice };
  else colony.evolution = { ...colony.evolution, tier3: choice };

  // Survival I's retroactive conversion (§14): every existing living worker
  // of this colony has its health/maxHealth rescaled in the same transaction
  // as the selection itself, preserving each worker's current HEALTH
  // PERCENTAGE rather than leaving it stale or magically full-healing. This
  // is genuinely new logic with no prior art in this codebase — every other
  // max-health write in the project sets health = maxHealth to a fixed
  // constant at creation time; nothing before this has ever rescaled a live
  // entity's max health. Deterministic rounding: Math.round, stated once.
  if (tier === 1 && choice === "survival") {
    const affected = [...workers.values()].filter((w) => w.colonyId === colonyId);
    const tx = db.transaction(() => {
      for (const worker of affected) {
        // Stage 10: newMax is per-worker — a mixed-caste colony rescales each
        // worker against its OWN caste's base maxHealth, not a single
        // colony-wide figure.
        const newMax = getEvolutionModifiers(colony.evolution, worker.caste).maxHealth;
        const newHealth = Math.round((worker.health / worker.maxHealth) * newMax);
        db.prepare("UPDATE workers SET health = ?, max_health = ? WHERE id = ?").run(newHealth, newMax, worker.id);
        worker.health = newHealth;
        worker.maxHealth = newMax;
      }
    });
    tx();
    dirty = true;
  }

  logAction(colonyId, "colony_evolved", { tier, choice });
  return true;
}

// Stage 8: the single authoritative, idempotent entry point for ending a
// colony's life — reached from both a lethal queen hit (applyDamageToQueen)
// and manual abandonment (actions.ts's abandon()). No second reset system:
// every lifecycle-ending path funnels through here.
//
// The `AND status = 'active'` guard is what makes this safe to call more
// than once (e.g. two spiders landing a simultaneous lethal hit in the same
// tick, or a race between a lethal hit and a manual abandon): a second call
// against an already-defeated colony updates zero rows and returns
// immediately, before any worker/resource deletion or logging — exactly-
// once is enforced by the database, not by caller discipline.
export function defeatColony(colonyId: number, cause: string, creatureId?: number): void {
  // Stage 12: generated in JS (not SQL's datetime('now')) so the exact same
  // ISO string lands in both the durable column and the in-memory SimColony
  // below — isRuinExpired() (ecology.ts) only ever has to parse one format.
  const defeatedAt = new Date().toISOString();
  const result = db
    .prepare("UPDATE colonies SET status = 'defeated', defeat_cause = ?, defeated_at = ? WHERE id = ? AND status = 'active'")
    .run(cause, defeatedAt, colonyId);
  if (result.changes === 0) return; // already defeated — no-op

  const workerIds = [...workers.values()].filter((w) => w.colonyId === colonyId).map((w) => w.id);
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM workers WHERE colony_id = ?").run(colonyId);
    db.prepare("DELETE FROM colony_resources WHERE colony_id = ?").run(colonyId);
  });
  tx();

  for (const id of workerIds) workers.delete(id);
  // Any spider chasing one of this colony's now-deleted workers, or chasing
  // this colony's queen directly, recovers to idle rather than holding a
  // dangling target — mirrors killWorker's own attacker-idle-sweep.
  for (const creature of creatures.values()) {
    const command = creature.command;
    const chasingDeadWorker = command.type === "chase" && workerIds.includes(command.targetWorkerId);
    const chasingThisQueen = command.type === "chase-queen" && command.targetColonyId === colonyId;
    if (chasingDeadWorker || chasingThisQueen) {
      creature.command = { type: "idle", remaining: pickIdleDuration(creature, WANDER_PARAMS[creature.species]) };
    }
  }

  const colony = colonies.get(colonyId);
  if (colony) {
    colony.status = "defeated";
    colony.health = 0;
    colony.defeatedAt = defeatedAt;
  }

  dirty = true;
  logAction(colonyId, "colony_defeated", { cause, creatureId });
}

// Mirrors applyDamageToWorker's durability discipline (synchronous write on
// every hit) but for a colony's queen. A no-op if the colony is missing or
// already defeated — a dead/ruined queen can never be damaged again. Lethal
// damage hands off to defeatColony(), the single authoritative end-of-life
// transaction.
export function applyDamageToQueen(colonyId: number, amount: number, spiderId: number): void {
  const colony = colonies.get(colonyId);
  if (!colony || colony.status !== "active") return;
  colony.health = Math.max(0, colony.health - amount);
  colony.timeSinceLastDamage = 0;
  db.prepare("UPDATE colonies SET queen_health = ? WHERE id = ?").run(colony.health, colony.id);
  dirty = true;
  if (colony.health <= 0) defeatColony(colonyId, "spider", spiderId);
}

// Stage 8: passive queen regeneration, called once per tick from
// advanceSimulation. Mirrors the project's existing position-vs-combat
// durability split: damage is synchronous-write (above), but these small
// per-tick increments are NOT written to SQLite here — they ride along in
// the periodic checkpointSimulation() flush instead, same as worker/creature
// position. Losing at most one checkpoint interval of regen progress on an
// ungraceful crash is harmless.
function advanceQueenRegen(dt: number): void {
  for (const colony of colonies.values()) {
    if (colony.status !== "active" || colony.health >= colony.maxHealth) continue;
    colony.timeSinceLastDamage += dt;
    if (colony.timeSinceLastDamage < QUEEN_REGEN_DELAY) continue;
    const next = Math.min(colony.maxHealth, colony.health + QUEEN_REGEN_RATE * dt);
    if (next !== colony.health) {
      colony.health = next;
      dirty = true;
    }
  }
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

  // Stage 9 Survival III: the existing issueAttackCommand guard
  // (!worker.carrying) already prevents a worker from being both carrying
  // and attacking at once, so this chase-speed bonus and Foraging III's
  // carry-speed bonus (in advanceSimulation's movement step below) can never
  // stack — an existing invariant, not new code. See CLAUDE.md.
  const colony = colonies.get(worker.colonyId);
  const modifiers = colony ? getEvolutionModifiers(colony.evolution, worker.caste) : undefined;
  const attackSpeed = CASTE_BASE_STATS[worker.caste].speed * (modifiers?.chaseSpeedMultiplier ?? 1);

  const dx = creature.x - worker.x;
  const dy = creature.y - worker.y;
  const dist = Math.hypot(dx, dy);

  if (dist > WORKER_ATTACK_RANGE) {
    const step = Math.min(attackSpeed * dt, dist - WORKER_ATTACK_RANGE + ARRIVAL_EPSILON);
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
    const creatureId = creature.id;
    const species = creature.species;
    // Stage 9 Survival II: applies only along this existing creature-attack
    // path (aphids, spiders) — attack target resolution never touches
    // workers/colonies, so this cannot introduce PvP by construction.
    const attackDamage = modifiers?.attackDamage ?? CASTE_BASE_STATS[worker.caste].attackDamage;
    const carcassId = applyDamage(creature, attackDamage);
    // Stage 7: aphid kills deliberately get no new log line (existing
    // aphid-combat tests/assertions are unaffected) — only a lethal hit on a
    // spider logs, gated on species.
    if (carcassId !== null && species === "spider") {
      logAction(worker.colonyId, "spider_died", { creatureId, carcassId });
    }
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
  const maxStep = CASTE_BASE_STATS[worker.caste].speed * dt;
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
  const nest = colonies.get(worker.colonyId)!;
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
// Stage 9 Foraging II: arrival no longer claims instantly — it starts a
// short in-memory channel timer instead (advanceSimulation's gather branch
// below ticks it down and performs the actual claim once it reaches zero).
// Gathering had no duration of any kind to speed up before this; rather than
// invent a large harvesting subsystem, every worker (evolved or not) now
// spends GATHER_DURATION seconds channeling on arrival, shortened by
// Foraging II's modifier — the smallest meaningful interpretation consistent
// with the brief's explicit permission (§12). See CLAUDE.md's Stage 9
// section for the full rationale.
function resolveArrival(worker: SimWorker, command: WorkerCommand): void {
  if (command.type === "gather") {
    const colony = colonies.get(worker.colonyId);
    const duration = colony ? getEvolutionModifiers(colony.evolution, worker.caste).gatherDuration : GATHER_DURATION;
    worker.command = { ...command, channelRemaining: duration };
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
  advanceCreatures(dt);
  advanceQueenRegen(dt);

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

    // Stage 9 Foraging II: a worker that's already arrived and is channeling
    // (channelRemaining set by resolveArrival) doesn't move and doesn't
    // re-check the node's existence — it's standing still, counting down.
    // Still takes the separation nudge so a channeling worker doesn't block
    // others from settling nearby, same as idle above.
    if (worker.command.type === "gather" && worker.command.channelRemaining !== undefined) {
      const newX = clamp(worker.x + separation.dx, 0, worldBounds.width);
      const newY = clamp(worker.y + separation.dy, 0, worldBounds.height);
      if (newX !== worker.x || newY !== worker.y) {
        worker.x = newX;
        worker.y = newY;
        dirty = true;
      }
      const remaining = worker.command.channelRemaining - dt;
      if (remaining > 0) {
        worker.command = { ...worker.command, channelRemaining: remaining };
      } else {
        worker.command = attemptGatherClaim(worker, worker.command.resourceId) ? { type: "return" } : { type: "idle" };
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
    // Stage 9 Foraging III: a carrying worker's `return` travel gets a speed
    // multiplier, applied dynamically here — never a stored per-worker speed
    // stat, and never applied to outbound gather/move travel (worker.carrying
    // is only ever set while the command is "return" — see
    // issueMoveCommand/issueGatherCommand's own carrying guards).
    const moveColony = colonies.get(worker.colonyId);
    const carrySpeedMultiplier =
      worker.carrying && moveColony
        ? getEvolutionModifiers(moveColony.evolution, worker.caste).carryMoveSpeedMultiplier
        : 1;
    // Stage 10: base speed is per-caste (Soldier slower, Scout much faster)
    // — applies to every worker's movement (plain move/gather travel and
    // carrying/return alike), not just the carry-speed-multiplier portion.
    const effectiveSpeed = CASTE_BASE_STATS[worker.caste].speed * carrySpeedMultiplier;
    const step = Math.min(effectiveSpeed * dt, dist - arrivalRange);
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
  // Stage 8: queen health's passive regen deliberately isn't written on
  // every tick (see advanceQueenRegen) — it rides along in this existing
  // periodic flush instead, same batched-write treatment position already
  // gets. Combat damage (applyDamageToQueen) stays its own synchronous
  // write, unaffected by this.
  const updateColonyHealth = db.prepare("UPDATE colonies SET queen_health = ? WHERE id = ?");
  const tx = db.transaction((workerList: SimWorker[], creatureList: SimCreature[], colonyList: SimColony[]) => {
    for (const w of workerList) update.run(w.x, w.y, w.id);
    for (const c of creatureList) updateCreature.run(c.x, c.y, c.id);
    for (const col of colonyList) updateColonyHealth.run(col.health, col.id);
  });
  tx([...workers.values()], [...creatures.values()], [...colonies.values()].filter((c) => c.status === "active"));
}

loadSimulation();
