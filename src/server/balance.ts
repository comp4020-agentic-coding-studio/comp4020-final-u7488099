export const WORLD = {
  width: 3000,
  height: 3000,
};

export const STARTING_WORKERS = 3;

// Stage 6b: every REPRODUCE_COST unit of starting protein lets a fresh
// colony reproduce once immediately, without waiting on a hunt-and-carry
// round trip first. Deliberately not "enormous" — exactly one reproduction's
// worth, enough to exercise the loop on arrival. See CLAUDE.md's Stage 6b
// section.
export const REPRODUCE_COST = 50;
export const STARTING_PROTEIN = REPRODUCE_COST;

export const RESOURCE_TYPES = ["sugar", "protein", "biomass"] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

// Stage 5: sugar nodes are finite + renewable (see CLAUDE.md for why that
// changed from genuinely infinite). Biomass/protein amounts are likewise
// named constants (not inlined per-node) so Stage 6b's generated node list
// and any future rebalancing share one source of truth per resource type.
export const SUGAR_NODE_MAX_AMOUNT = 100;
export const BIOMASS_NODE_MAX_AMOUNT = 500;
export const PROTEIN_NODE_AMOUNT = 200;

// Units regenerated per second at a node below its maxAmount. Rates are
// arbitrary — balancing isn't a priority this stage — chosen only so
// regeneration is comfortably observable in both direct-import tests (which
// pass arbitrary dt) and a manual playtest.
export const SUGAR_REGEN_RATE = 4;
export const BIOMASS_REGEN_RATE = 3;

// Single source of truth for "is this resource type renewable": presence as
// a key here drives both the regen tick and attemptGatherClaim's no-delete-
// at-zero behavior in simulation.ts. Protein has no entry — it never
// regenerates and keeps the original delete-on-depletion behavior.
export const RESOURCE_REGEN_RATES: Partial<Record<ResourceType, number>> = {
  sugar: SUGAR_REGEN_RATE,
  biomass: BIOMASS_REGEN_RATE,
};

// Shared by computeGroupDestinations (simulation.ts), createColony (db.ts),
// and Stage 6b's world-population generator below — one golden-angle spiral
// constant and one placement formula, not three copies of the same idea.
export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
export const COLONY_SPACING = 300;
export const COLONY_PLACEMENT_MARGIN = 200;

// Crit 10: each new session mints its own colony, placed on the same
// golden-angle spiral computeGroupDestinations already uses for group worker
// placement, centred on the world instead of a click point. Colony index 0
// (the very first colony any world ever seeds) gets radius 0 — exactly
// (width/2, height/2), the pre-Crit-10 single-colony seed position,
// unchanged. COLONY_PLACEMENT_MARGIN keeps a freshly spiralled queen (and
// its starting workers, offset up to ~100 units away) comfortably inside
// world bounds rather than clamped flush against an edge.
//
// Stage 6b reuses this exact function (not a re-derivation of the formula)
// to decide where to place resource/aphid clusters, so "likely colony spawn
// region" and "has useful nearby content" are the same coordinates by
// construction rather than two things that could drift apart.
export function colonySpiralPosition(index: number): { x: number; y: number } {
  const radius = COLONY_SPACING * Math.sqrt(index);
  const angle = index * GOLDEN_ANGLE;
  const margin = COLONY_PLACEMENT_MARGIN;
  const x = Math.min(Math.max(WORLD.width / 2 + radius * Math.cos(angle), margin), WORLD.width - margin);
  const y = Math.min(Math.max(WORLD.height / 2 + radius * Math.sin(angle), margin), WORLD.height - margin);
  return { x, y };
}

// --- Stage 6b: deterministic world population -----------------------------
//
// Replaces the original Stage 1 hand-placed 12-node array and Stage 5's
// 14-position aphid seed with a generated, denser, deterministic world: a
// cluster of resources + aphids around each of the first SPAWN_ANCHOR_COUNT
// colony-spiral positions (so every colony a playtest actually mints has
// useful nearby content on arrival — see CLAUDE.md's Stage 6b section),
// plus a scatter of extra content across the rest of the map so exploring
// away from any one colony still finds things. SPAWN_ANCHOR_COUNT=10 is not
// arbitrary: it's exactly enough to cover every colony index the test suite
// ever claims (colony.test.ts's session lands on index 0; multiplayer.test's
// 8 alice/bob sessions claim indices 1-8; realtime.test.ts's session claims
// index 9) — see spec/*.test.ts.
//
// Generation uses a fixed-seed PRNG (mulberry32, seeded with a literal
// constant — never Math.random/Date.now) so positions are irregular-looking
// but 100% reproducible: the same seed always produces the same world, which
// is what makes a fresh deploy's layout, and the test suite's assumptions
// about it, stable. This is "deterministic initial world seeding" computed
// once at module load, not runtime procedural spawning — equivalent in
// spirit to Stage 1's hand-typed array, just generated instead of typed by
// hand because hand-placing 100+ coordinates isn't practical at this
// density.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SPAWN_ANCHOR_COUNT = 10;
export const SUGAR_PER_ANCHOR = 3;
export const BIOMASS_PER_ANCHOR = 2;
export const APHIDS_PER_ANCHOR = 4;
// Every PROTEIN_ANCHOR_STRIDE-th anchor also gets one finite protein deposit
// nearby — protein sources are deliberately rarer than sugar/biomass since
// hunting aphids is the primary, renewable protein loop; these are a bonus,
// not the main source (see CLAUDE.md's Stage 6b section).
export const PROTEIN_ANCHOR_STRIDE = 2;

// Background content scattered across the whole map, not tied to any one
// colony's spawn, so exploring away from a colony still finds things and the
// map doesn't read as "rich near colonies, empty everywhere else".
export const SCATTER_SUGAR_COUNT = 6;
export const SCATTER_BIOMASS_COUNT = 8;
export const SCATTER_PROTEIN_COUNT = 3;
export const SCATTER_APHID_COUNT = 12;

// Stage 7: how many spiders a fresh world seeds, and how far from every
// spawn anchor they must land. Declared here (not alongside the rest of the
// spider constants further down) because buildWorldPopulation() below
// closes over both at generation time — they need to exist before that
// function runs, unlike the AI/combat spider constants, which nothing at
// generation time reads.
export const SPIDER_COUNT = 10;
// Larger than ANCHOR_CLEAR_RADIUS (120) on purpose: spiders are hostile, so
// they're kept further from spawns than resources/aphids, while still
// landing well within world bounds at this world size.
export const SPIDER_CLEAR_RADIUS = 400;

// A cluster item lands at a random angle and this radius from its anchor —
// far enough out that nothing sits on top of the queen or the starting
// workers, close enough that a fresh colony doesn't have to travel far to
// start gathering/hunting. Stage 10: the max radius must stay under
// VISION_RADIUS.queen (300) — one of the first SPAWN_ANCHOR_COUNT colonies
// spawns exactly on its own anchor (colonySpiralPosition(index) is the same
// sequence createColony() uses), so under fog of war its queen must be able
// to see its own anchor's cluster without anyone moving first. 280 leaves a
// 20-unit margin under that radius.
const ANCHOR_CLUSTER_MIN_RADIUS = 150;
// Exported for Stage 12: ecology's anchor zone radius (ECOLOGY_ANCHOR_ZONE_RADIUS)
// is sized to comfortably contain this jitter band.
export const ANCHOR_CLUSTER_MAX_RADIUS = 280;
// Scattered (non-cluster) content keeps this far from every anchor, so
// "background" placement never accidentally drops something on a queen.
const ANCHOR_CLEAR_RADIUS = 120;
// Fixed, literal seed — not Math.random()/Date.now() — so the generated
// world is exactly reproducible on every boot and every test run.
const WORLD_SEED = 1337;

type GeneratedNode = {
  x: number;
  y: number;
  resourceType: ResourceType;
  amount: number;
  maxAmount: number;
};

function buildWorldPopulation(): {
  resourceNodes: GeneratedNode[];
  aphidPositions: { x: number; y: number }[];
  spiderPositions: { x: number; y: number }[];
} {
  const rng = mulberry32(WORLD_SEED);
  const anchors = Array.from({ length: SPAWN_ANCHOR_COUNT }, (_, i) => colonySpiralPosition(i));

  const resourceNodes: GeneratedNode[] = [];
  const aphidPositions: { x: number; y: number }[] = [];

  function clamp(value: number, lo: number, hi: number): number {
    return Math.min(Math.max(value, lo), hi);
  }

  function placeNearAnchor(anchor: { x: number; y: number }): { x: number; y: number } {
    const angle = rng() * Math.PI * 2;
    const radius = ANCHOR_CLUSTER_MIN_RADIUS + rng() * (ANCHOR_CLUSTER_MAX_RADIUS - ANCHOR_CLUSTER_MIN_RADIUS);
    return {
      x: clamp(anchor.x + Math.cos(angle) * radius, COLONY_PLACEMENT_MARGIN, WORLD.width - COLONY_PLACEMENT_MARGIN),
      y: clamp(anchor.y + Math.sin(angle) * radius, COLONY_PLACEMENT_MARGIN, WORLD.height - COLONY_PLACEMENT_MARGIN),
    };
  }

  // Bounded retries, not unbounded — this stays a pure, terminating function
  // of the fixed seed even in the pathological case every draw rejects.
  // clearRadius defaults to the background-scatter distance (resources/
  // aphids); Stage 7 passes SPIDER_CLEAR_RADIUS instead, reusing this same
  // rejection-sampling loop rather than writing a second one.
  function placeScattered(clearRadius: number = ANCHOR_CLEAR_RADIUS): { x: number; y: number } {
    for (let attempt = 0; attempt < 20; attempt++) {
      const x = COLONY_PLACEMENT_MARGIN + rng() * (WORLD.width - 2 * COLONY_PLACEMENT_MARGIN);
      const y = COLONY_PLACEMENT_MARGIN + rng() * (WORLD.height - 2 * COLONY_PLACEMENT_MARGIN);
      if (anchors.every((a) => Math.hypot(a.x - x, a.y - y) > clearRadius)) return { x, y };
    }
    return { x: WORLD.width / 2, y: WORLD.height / 2 };
  }

  anchors.forEach((anchor, index) => {
    for (let i = 0; i < SUGAR_PER_ANCHOR; i++) {
      const { x, y } = placeNearAnchor(anchor);
      resourceNodes.push({ x, y, resourceType: "sugar", amount: SUGAR_NODE_MAX_AMOUNT, maxAmount: SUGAR_NODE_MAX_AMOUNT });
    }
    for (let i = 0; i < BIOMASS_PER_ANCHOR; i++) {
      const { x, y } = placeNearAnchor(anchor);
      resourceNodes.push({ x, y, resourceType: "biomass", amount: BIOMASS_NODE_MAX_AMOUNT, maxAmount: BIOMASS_NODE_MAX_AMOUNT });
    }
    if (index % PROTEIN_ANCHOR_STRIDE === 0) {
      const { x, y } = placeNearAnchor(anchor);
      resourceNodes.push({ x, y, resourceType: "protein", amount: PROTEIN_NODE_AMOUNT, maxAmount: PROTEIN_NODE_AMOUNT });
    }
    for (let i = 0; i < APHIDS_PER_ANCHOR; i++) {
      aphidPositions.push(placeNearAnchor(anchor));
    }
  });

  for (let i = 0; i < SCATTER_SUGAR_COUNT; i++) {
    const { x, y } = placeScattered();
    resourceNodes.push({ x, y, resourceType: "sugar", amount: SUGAR_NODE_MAX_AMOUNT, maxAmount: SUGAR_NODE_MAX_AMOUNT });
  }
  for (let i = 0; i < SCATTER_BIOMASS_COUNT; i++) {
    const { x, y } = placeScattered();
    resourceNodes.push({ x, y, resourceType: "biomass", amount: BIOMASS_NODE_MAX_AMOUNT, maxAmount: BIOMASS_NODE_MAX_AMOUNT });
  }
  for (let i = 0; i < SCATTER_PROTEIN_COUNT; i++) {
    const { x, y } = placeScattered();
    resourceNodes.push({ x, y, resourceType: "protein", amount: PROTEIN_NODE_AMOUNT, maxAmount: PROTEIN_NODE_AMOUNT });
  }
  for (let i = 0; i < SCATTER_APHID_COUNT; i++) {
    aphidPositions.push(placeScattered());
  }

  // Spiders are scattered across the whole map, never anchor-clustered —
  // a predator shouldn't crowd every colony's spawn the way resources/aphids
  // deliberately do.
  const spiderPositions: { x: number; y: number }[] = [];
  for (let i = 0; i < SPIDER_COUNT; i++) {
    spiderPositions.push(placeScattered(SPIDER_CLEAR_RADIUS));
  }

  return { resourceNodes, aphidPositions, spiderPositions };
}

const WORLD_POPULATION = buildWorldPopulation();

// Stage 6b: generated (see buildWorldPopulation above), not hand-typed —
// ~36 sugar + ~28 biomass + ~8 protein sources clustered around the first
// SPAWN_ANCHOR_COUNT colony spawn points plus scattered across the map.
export const RESOURCE_NODES: GeneratedNode[] = WORLD_POPULATION.resourceNodes;

// Stage 6b: generated — ~52 aphids clustered around spawn points plus
// scattered across the map (up from Stage 5's original hand-placed 14).
export const APHID_SEED_POSITIONS: { x: number; y: number }[] = WORLD_POPULATION.aphidPositions;

// Stage 7: generated — SPIDER_COUNT positions, scattered (never
// anchor-clustered) and kept SPIDER_CLEAR_RADIUS from every spawn anchor.
export const SPIDER_SEED_POSITIONS: { x: number; y: number }[] = WORLD_POPULATION.spiderPositions;

// How much a single successful claim picks up into a worker's `carrying`,
// and how much it decrements a finite node's remaining amount (capped at
// whatever's left — see attemptGatherClaim in simulation.ts). Stage 4
// repurposed this from "amount credited on claim" to "amount picked up on
// claim" — the colony isn't credited until deposit.
export const GATHER_YIELD = 10;
// How close a gathering worker must get to a resource's centre before a
// claim is attempted. Bigger than any NODE_RADIUS so workers visibly stop at
// the node's edge rather than overlapping its centre.
export const GATHER_RANGE = 30;
// How close a returning worker must get to the queen before its carried
// payload is deposited. A separate constant from GATHER_RANGE even though
// both start at 30 — gather and deposit ranges are conceptually unrelated
// and may diverge later. Kept above MIN_SEPARATION (20) for the same reason
// GATHER_RANGE already is: several simultaneous returners can all be in
// deposit range of the queen while still keeping separation distance from
// each other.
export const DEPOSIT_RANGE = 30;

export const WORKER_SPEED = 150; // world units per second

// Stage 3: loose swarm spacing. MIN_SEPARATION is deliberately exactly
// 2 * WORKER_RADIUS ("circles just touching") — the natural threshold for
// "don't visually overlap", and also what keeps separation from firing at
// the fixed 20-unit gap baked into spec/simulation.test.ts's "arrival" test
// (separationDelta uses a strict `<` comparison). See CLAUDE.md.
export const WORKER_RADIUS = 10;
export const MIN_SEPARATION = WORKER_RADIUS * 2;
export const SEPARATION_STRENGTH = 80; // world units/sec of push at full overlap, well under WORKER_SPEED
export const GROUP_DESTINATION_SPACING = WORKER_RADIUS * 2;

// Simulation cadence: ticking faster than it broadcasts is deliberate — the
// authoritative position updates smoothly in memory even though clients only
// see a new frame every BROADCAST_HZ. See CLAUDE.md.
export const SIMULATION = {
  tickHz: 10,
  broadcastHz: 5,
  checkpointIntervalMs: 5000,
};

// Stage 5: first neutral autonomous creature. Generic enough (species as a
// string, not an enum) that Stage 6 can add new species without a schema
// change, but nothing more — no HP, no AI beyond wander, by design.
export const APHID_RADIUS = 6; // client rendering only; no server-side collision geometry
export const APHID_SPEED = 40; // world units/sec — well under WORKER_SPEED (150), reads as ambling
export const APHID_WANDER_RADIUS = 150; // max distance a newly chosen destination can land from the current spot
export const APHID_IDLE_MIN = 1; // seconds idle before choosing a new destination
export const APHID_IDLE_MAX = 4;

// Stage 6: creature health. Keyed by species so a future species needs only
// a new map entry, not a schema change (health/maxHealth columns are
// already species-agnostic). Placeholder value: a single worker kills an
// aphid in 3 hits (~3s at WORKER_ATTACK_COOLDOWN=1s), fast enough that
// realtime/death tests stay quick. Balancing isn't a priority this stage.
export const APHID_MAX_HEALTH = 30;

// Stage 7: the one hostile predator species. Tuned so 3 hits from an
// isolated worker kill it (SPIDER_MAX_HEALTH / WORKER_ATTACK_DAMAGE),
// mirroring the aphid's own "3 worker hits" balance note above, while a
// spider's own attack also kills an isolated worker in 3 hits
// (WORKER_MAX_HEALTH / SPIDER_ATTACK_DAMAGE) — a fair fight, one on one.
export const SPIDER_MAX_HEALTH = 30;

export const SPECIES_MAX_HEALTH: Record<string, number> = {
  aphid: APHID_MAX_HEALTH,
  spider: SPIDER_MAX_HEALTH,
};

// Protein credited to the colony's economy once a carcass is fully
// harvested (split across however many gather claims it takes at
// GATHER_YIELD per claim).
export const APHID_PROTEIN_VALUE = 30;
// A spider is a tougher kill than an aphid, so its carcass pays out more.
export const SPIDER_PROTEIN_VALUE = 100;

// Stage 7: generalizes the (previously hardcoded) APHID_PROTEIN_VALUE
// lookup in killCreature so a new species needs only a new map entry, same
// precedent as SPECIES_MAX_HEALTH above.
export const CREATURE_PROTEIN_VALUE: Record<string, number> = {
  aphid: APHID_PROTEIN_VALUE,
  spider: SPIDER_PROTEIN_VALUE,
};

// Chosen comfortably above MIN_SEPARATION (20) so the separation force can
// never prevent a worker reaching attack range — same scale as GATHER_RANGE
// (30). Damage/cooldown are placeholders: APHID_MAX_HEALTH / WORKER_ATTACK_DAMAGE
// hits to kill, WORKER_ATTACK_COOLDOWN seconds apart.
export const WORKER_ATTACK_RANGE = 30;
export const WORKER_ATTACK_DAMAGE = 10;
export const WORKER_ATTACK_COOLDOWN = 1;

// Stage 7: workers gain durable health, following the exact precedent
// APHID_MAX_HEALTH/SPECIES_MAX_HEALTH set for creatures. A spider's
// SPIDER_ATTACK_DAMAGE is chosen so 3 hits kill an isolated worker, mirroring
// the "aphid dies in 3 worker hits" balance note above.
export const WORKER_MAX_HEALTH = 30;

// Stage 7: spider movement/wander tuning, parallel to the APHID_* constants
// above — shares the same idle/wander state machine (see advanceWander in
// simulation.ts). Faster than an aphid (40) so a chase is a real threat, but
// still under worker speed (150) so fleeing is always viable.
export const SPIDER_RADIUS = 10; // client rendering only; larger than aphid, reads as more threatening
export const SPIDER_SPEED = 70;
export const SPIDER_WANDER_RADIUS = 150;
export const SPIDER_IDLE_MIN = 1;
export const SPIDER_IDLE_MAX = 4;

// A spider notices a worker within SPIDER_AGGRO_RANGE and gives up the
// chase once its target gets beyond SPIDER_DISENGAGE_RANGE — the gap
// between the two means a worker that starts fleeing the instant it's
// noticed has a real chance to break the chase, rather than aggro and
// disengage being a single hair-trigger boundary.
export const SPIDER_AGGRO_RANGE = 200;
export const SPIDER_DISENGAGE_RANGE = 300;
// Matches WORKER_ATTACK_RANGE/COOLDOWN's own scale reasoning — comfortably
// above MIN_SEPARATION (20) so separation can never prevent a spider
// reaching melee range.
export const SPIDER_ATTACK_RANGE = 30;
export const SPIDER_ATTACK_DAMAGE = 10;
export const SPIDER_ATTACK_COOLDOWN = 1;

// Stage 9: evolution milestones are gated on a colony's PEAK population
// (highest living-worker count its lineage has ever reached), never current
// population — see CLAUDE.md's Stage 9 section. Exactly 3 tiers, thresholds
// are explicit balance placeholders, not the result of any tuning pass.
export const EVOLUTION_TIER_1_POPULATION = 5;
export const EVOLUTION_TIER_2_POPULATION = 10;
export const EVOLUTION_TIER_3_POPULATION = 20;

// Stage 9: nine permanent, freely-mixable traits across three branches
// (Foraging/Survival/Brood) and three tiers — every multiplier below is
// provisional per the brief (§4); no balancing pass has been done.
export const FORAGING_I_CARRY_MULTIPLIER = 1.5; // Strong Mandibles: +50% carried per claim
export const SURVIVAL_I_HEALTH_MULTIPLIER = 1.5; // Hardened Carapace: +50% max health
export const BROOD_I_COST_MULTIPLIER = 0.8; // Efficient Brood: 20% cheaper reproduction

export const FORAGING_II_GATHER_SPEED_MULTIPLIER = 1.3; // Efficient Foragers: 30% faster gather
export const SURVIVAL_II_ATTACK_MULTIPLIER = 1.5; // Powerful Mandibles: +50% attack damage
export const BROOD_II_COST_MULTIPLIER = 0.65; // Rapid Development: 35% cheaper reproduction

export const FORAGING_III_CARRY_SPEED_MULTIPLIER = 1.25; // Trail Instinct: +25% move speed while carrying
export const SURVIVAL_III_CHASE_SPEED_MULTIPLIER = 1.25; // Predator Instinct: +25% move speed while attacking/chasing
export const BROOD_III_COST_MULTIPLIER = 0.5; // Thriving Colony: 50% cheaper reproduction

// Stage 9: gathering is otherwise instantaneous on arrival (see
// attemptGatherClaim in simulation.ts) — Foraging II ("gather 30% faster")
// has nothing to speed up as the architecture stood before this. Rather than
// build a large new harvesting subsystem, this introduces the smallest
// meaningful channel-duration mechanic: every worker (evolved or not) spends
// this many seconds "channeling" on arrival before a claim is attempted.
// Foraging II shortens it; nobody else's gather behavior changes in kind,
// only in speed. See CLAUDE.md's Stage 9 section for the full rationale.
export const GATHER_DURATION = 1; // seconds; baseline channel time, applies to every worker

// Stage 9: exact display names from the brief (§4), shared by the world
// event feed template and the client Evolution panel — one source of truth
// instead of hand-typing the same strings in two places.
export const TRAIT_DISPLAY_NAMES: Record<1 | 2 | 3, Record<"foraging" | "survival" | "brood", string>> = {
  1: { foraging: "Strong Mandibles", survival: "Hardened Carapace", brood: "Efficient Brood" },
  2: { foraging: "Efficient Foragers", survival: "Powerful Mandibles", brood: "Rapid Development" },
  3: { foraging: "Trail Instinct", survival: "Predator Instinct", brood: "Thriving Colony" },
};

// Stage 8: the queen gains her own durable health pool, following the exact
// precedent WORKER_MAX_HEALTH set. 200 means a lone spider (10 dmg/hit,
// 1s cooldown) takes 20s of uninterrupted attack to kill an undefended
// queen — long enough that a player who notices has a real chance to
// intervene, but short enough that an abandoned colony is genuinely at risk.
export const QUEEN_MAX_HEALTH = 200;

// A queen stops taking damage and, after a delay with no further hits,
// begins slowly regenerating — same idle/cooldown-driven feel as combat
// elsewhere, not a new mechanic. Own named constants (not reused from
// worker/spider ones) so queen tuning can move independently later.
export const QUEEN_REGEN_DELAY = 10;
export const QUEEN_REGEN_RATE = 2;

// A spider only ever notices a queen after wandering/chasing its way
// inside this range (see simulation.ts's advanceSpider queen-aggro scan
// for why no nest-exclusion gate applies here). Own named constants,
// distinct from SPIDER_AGGRO_RANGE/SPIDER_DISENGAGE_RANGE, even though
// initially equal in value.
export const QUEEN_AGGRO_RANGE = 200;
export const QUEEN_DISENGAGE_RANGE = 300;

// Stage 10: exactly three unit-level castes. Every existing/pre-Stage-10
// worker becomes 'worker' via migration (see db.ts's migrateWorkerCaste/
// backfillWorkerCaste) — this is a durable, persistent property of the unit,
// not a transient UI label. See CLAUDE.md's Stage 10 section.
export type Caste = "worker" | "soldier" | "scout";

// Stage 10 (§4): caste determines a unit's BASE stats; Stage 9 evolution
// then scales whichever of these are "applicable" per trait (see
// evolution.ts's getEvolutionModifiers). Worker is exactly the pre-Stage-10
// baseline (reuses the existing flat constants, not duplicated numbers) so
// every pre-Stage-10 behavior/test is preserved byte-for-byte. Soldier/Scout
// values are the brief's own suggested placeholders (§4) — no balancing
// pass. Soldier's carryCapacity of 0 is what backs its structural inability
// to gather/carry (enforced in simulation.ts, not just a UI hint).
export const CASTE_BASE_STATS: Record<
  Caste,
  { maxHealth: number; attackDamage: number; speed: number; reproduceCost: number; carryCapacity: number }
> = {
  worker: {
    maxHealth: WORKER_MAX_HEALTH,
    attackDamage: WORKER_ATTACK_DAMAGE,
    speed: WORKER_SPEED,
    reproduceCost: REPRODUCE_COST,
    carryCapacity: GATHER_YIELD,
  },
  soldier: { maxHealth: 60, attackDamage: 20, speed: 120, reproduceCost: 100, carryCapacity: 0 },
  scout: { maxHealth: 18, attackDamage: 5, speed: 240, reproduceCost: 60, carryCapacity: 5 },
};

// Stage 10 (§14): current-visibility fog of war vision radii. Fixed
// placeholders, deliberately NOT modified by Stage 9 evolution (§14 is
// explicit that vision stays constant regardless of evolution tier). Queen
// isn't a caste but is its own vision source with its own radius, hence the
// separate "queen" key alongside the three castes.
export const VISION_RADIUS: Record<"queen" | Caste, number> = {
  queen: 300,
  worker: 180,
  soldier: 180,
  scout: 400,
};

// Stage 10 (§18): a defeated colony (no active queen, no living units) keeps
// a small consolation view of its own ruin rather than a black screen or
// global omniscience. Deliberately smaller than every living-unit radius
// above (150 < 180 <= 300 <= 400) — a defeated player sees meaningfully less
// than an active one, not more.
export const DEFEATED_COLONY_VISION_RADIUS = 150;

// Stage 12: persistent world ecology. Zones are derived, not stored — see
// CLAUDE.md's Stage 12 section for the full rationale behind every number
// here. Anchor zones reuse colonySpiralPosition(i) for i in
// 0..SPAWN_ANCHOR_COUNT-1 as their centers; everywhere else falls into the
// background grid.
export const ECOLOGY_ANCHOR_ZONE_RADIUS = 300;
export const ECOLOGY_BACKGROUND_CELL_SIZE = 300;

// Deliberately its own setInterval in index.ts, decoupled from
// SIMULATION.tickHz/broadcastHz — a single O(resourceNodes + creatures) pass
// every 5s, not a per-tick scan (see Stage 10's documented anti-pattern).
export const ECOLOGY_EVAL_INTERVAL_MS = 5000;

// Only the 5 ecology-eligible types count; player units (workers/queens)
// always contribute zero density.
export const ECOLOGY_DENSITY_WEIGHTS: Record<ResourceType | "aphid" | "spider", number> = {
  sugar: 1,
  biomass: 1.5,
  protein: 2,
  aphid: 2,
  spider: 5,
};

// Matches what one Stage-6b anchor originally held (3 sugar + 2 biomass*1.5 +
// 4 aphid*2 + ~0.5 avg protein*2 ≈ 15) / the original scatter density
// (~0.5/cell, rounded up to keep background zones genuinely alive).
export const ECOLOGY_ANCHOR_TARGET_DENSITY = 15;
export const ECOLOGY_BACKGROUND_TARGET_DENSITY = 1;

// A zone below target starts a randomized deadline in this range; recovering
// above target before it elapses cancels it (continuous depletion required).
export const ECOLOGY_REGEN_DEADLINE_MIN_MS = 15_000;
export const ECOLOGY_REGEN_DEADLINE_MAX_MS = 60_000;

// Scarcity-weighted spawn type selection: weight = baseShare * (1 +
// SCARCITY_BOOST_FACTOR * max(0, 1 - currentCount/expectedCount)). 8 (not the
// originally-floated 3) is what actually makes a zone with zero protein much
// more likely to spawn protein next to abundant sugar/biomass.
export const SCARCITY_BOOST_FACTOR = 8;

// Emergency backstop only, counted as raw entities (sugar+biomass+protein
// source nodes plus aphid+spider creatures) — not the weighted density unit
// the per-zone targets use. ~1.5-1.9x the 160-195 raw entity "normal, fully
// provisioned" range derived in the Stage 12 plan.
export const MAX_ECOLOGY_ENTITIES = 300;

// Both active queens and non-expired ruins exclude ecology spawns within this
// radius — a visible ruin still occupies its footprint exactly like an active
// queen does, until the instant it expires (see RUIN_LIFETIME_MS below).
export const ECOLOGY_QUEEN_EXCLUSION_RADIUS = 250;

// How long a defeated colony's ruin stays visible/spawn-blocking/ecology-
// excluding before it physically & ecologically expires. Historical DB rows
// (evolution, defeat cause, admin visibility) are never affected by this —
// only live-world visibility and spatial exclusion expire.
export const RUIN_LIFETIME_MS = 600_000;

// Stage 12 addendum: global population scarcity. Motivated by an observed
// real extinction in the shared dev world — spider's old ANCHOR_BASE_SHARE/
// BACKGROUND_BASE_SHARE of 0 meant pickSpawnType() unconditionally excluded
// it from ever being ecology-spawned, so once the seeded population was
// hunted out it could never recover. The fix adds a second, independent
// factor to WHAT gets selected (never touching WHEN regeneration happens,
// which stays entirely local-density-driven): score = rarity x local
// scarcity x global scarcity. See CLAUDE.md for the full derivation.

// Explicit rarity ranks, generalizing the base-weight idea already used by
// ANCHOR_BASE_SHARE/BACKGROUND_BASE_SHARE in ecology.ts. Those two maps stay
// exactly as they are — they drive the LOCAL scarcity term (a zone-tier's
// expected per-type mix) — rarity is a different, single global weight per
// type shared by every zone regardless of tier.
export type EcologyRarity = "common" | "uncommon" | "rare" | "extremelyRare";
export const RARITY_BASE_WEIGHT: Record<EcologyRarity, number> = {
  common: 1.0,
  uncommon: 0.55,
  rare: 0.25,
  extremelyRare: 0.08,
};
export const ECOLOGY_TYPE_RARITY: Record<"sugar" | "biomass" | "protein" | "aphid" | "spider", EcologyRarity> = {
  sugar: "common",
  biomass: "uncommon",
  aphid: "uncommon",
  protein: "rare",
  spider: "extremelyRare",
};

// World-size-scaled desired populations: worldScale = currentWorldArea /
// REFERENCE_WORLD_AREA, so desiredPopulation_i = referenceDesiredPopulation_i
// * worldScale. A future, larger world naturally wants proportionally more
// of everything without ever hardcoding an absolute population target. The
// current 3000x3000 WORLD also happens to be the reference world for now
// (worldScale = 1 today) — the two are allowed to diverge once the real game
// world grows past this temporary map.
export const REFERENCE_WORLD_AREA = WORLD.width * WORLD.height;

// Reference desired global population per type at REFERENCE_WORLD_AREA.
// Deliberately set to Stage 6b's own original seeded totals (the
// distribution this game was already designed and balanced around), not
// invented numbers: SUGAR_PER_ANCHOR*SPAWN_ANCHOR_COUNT+SCATTER_SUGAR_COUNT,
// and so on for each type. These are ecological *targets/densities*, never
// hard caps — see MAX_ECOLOGY_ENTITIES above, which remains the only hard
// (technical, not ecological) ceiling.
export const REFERENCE_DESIRED_POPULATION: Record<"sugar" | "biomass" | "protein" | "aphid" | "spider", number> = {
  sugar: SUGAR_PER_ANCHOR * SPAWN_ANCHOR_COUNT + SCATTER_SUGAR_COUNT,
  biomass: BIOMASS_PER_ANCHOR * SPAWN_ANCHOR_COUNT + SCATTER_BIOMASS_COUNT,
  protein: Math.round(SPAWN_ANCHOR_COUNT / PROTEIN_ANCHOR_STRIDE) + SCATTER_PROTEIN_COUNT,
  aphid: APHIDS_PER_ANCHOR * SPAWN_ANCHOR_COUNT + SCATTER_APHID_COUNT,
  spider: SPIDER_COUNT,
};

// Bounded exponential global-scarcity pressure: globalScarcity_i =
// min(G_MAX, exp(K * deficiency_i^2)) where deficiency_i = max(0, 1 -
// currentPopulation_i / desiredPopulation_i). At/above desired population
// the multiplier is exactly 1; it rises smoothly, but never past G_MAX, as
// population falls toward zero. K=4 was tuned so ratio=0.75 -> ~1.28x,
// 0.5 -> ~2.72x, 0.25 -> ~9.49x, 0.1 -> ~25.5x, extinct -> e^4 ~= 54.6,
// capped at G_MAX=50 — mild underpopulation barely moves spawn odds, severe
// depletion increasingly overrides normal rarity, and extinction creates
// strong recovery pressure that collapses back to baseline the instant the
// population recovers.
export const GLOBAL_SCARCITY_K = 4;
export const GLOBAL_SCARCITY_MAX_MULTIPLIER = 50;
