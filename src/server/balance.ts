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
// start gathering/hunting.
const ANCHOR_CLUSTER_MIN_RADIUS = 150;
const ANCHOR_CLUSTER_MAX_RADIUS = 450;
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
  amount: number | null;
  maxAmount: number | null;
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
