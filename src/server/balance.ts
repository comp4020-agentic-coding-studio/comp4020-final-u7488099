export const WORLD = {
  width: 3000,
  height: 3000,
};

export const STARTING_WORKERS = 3;

export const RESOURCE_TYPES = ["sugar", "protein", "biomass"] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

// Stage 5: sugar nodes are now finite + renewable (previously amount: null,
// i.e. genuinely infinite — see CLAUDE.md for why that changed). Chosen
// loosely around protein's scale: big enough that normal play and the HTTP
// test suite never exhaust a single node, small enough that a manual
// gather-to-zero check doesn't take forever.
export const SUGAR_NODE_MAX_AMOUNT = 100;

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

// Stage 1 seed: fixed, deterministic positions spread across the world so it
// visibly exceeds any one viewport. Not randomised — a fresh seed, and a
// test run, must be reproducible. `amount`/`maxAmount` now drive real
// depletion via Stage 1c's travel + claim gather (see simulation.ts).
export const RESOURCE_NODES: {
  x: number;
  y: number;
  resourceType: ResourceType;
  amount: number | null;
  maxAmount: number | null;
}[] = [
  // sugar/nectar: small, plentiful, renewable (Stage 5) — depletes like any
  // finite node but regenerates over time via RESOURCE_REGEN_RATES below.
  { x: 1200, y: 1200, resourceType: "sugar", amount: SUGAR_NODE_MAX_AMOUNT, maxAmount: SUGAR_NODE_MAX_AMOUNT },
  { x: 1800, y: 1200, resourceType: "sugar", amount: SUGAR_NODE_MAX_AMOUNT, maxAmount: SUGAR_NODE_MAX_AMOUNT },
  { x: 1200, y: 1800, resourceType: "sugar", amount: SUGAR_NODE_MAX_AMOUNT, maxAmount: SUGAR_NODE_MAX_AMOUNT },
  { x: 1800, y: 1800, resourceType: "sugar", amount: SUGAR_NODE_MAX_AMOUNT, maxAmount: SUGAR_NODE_MAX_AMOUNT },
  { x: 1500, y: 900, resourceType: "sugar", amount: SUGAR_NODE_MAX_AMOUNT, maxAmount: SUGAR_NODE_MAX_AMOUNT },
  { x: 1500, y: 2100, resourceType: "sugar", amount: SUGAR_NODE_MAX_AMOUNT, maxAmount: SUGAR_NODE_MAX_AMOUNT },
  // protein: medium-sized prey, finite, non-renewable.
  { x: 700, y: 1500, resourceType: "protein", amount: 200, maxAmount: 200 },
  { x: 2300, y: 1500, resourceType: "protein", amount: 200, maxAmount: 200 },
  { x: 1500, y: 700, resourceType: "protein", amount: 200, maxAmount: 200 },
  { x: 1500, y: 2300, resourceType: "protein", amount: 200, maxAmount: 200 },
  // biomass: large, rare, finite — placed at the far corners to make the
  // world's size obvious.
  { x: 300, y: 300, resourceType: "biomass", amount: 500, maxAmount: 500 },
  { x: 2700, y: 2700, resourceType: "biomass", amount: 500, maxAmount: 500 },
];

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
export const REPRODUCE_COST = 50;

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

// Shared by computeGroupDestinations (simulation.ts) and createColony
// (db.ts) — one golden-angle spiral constant, not two copies of the same
// irrational number.
export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// Crit 10: each new session mints its own colony, placed on the same
// golden-angle spiral computeGroupDestinations already uses for group worker
// placement, centred on the world instead of a click point. Colony index 0
// (the very first colony any world ever seeds) gets radius 0 — exactly
// (width/2, height/2), the pre-Crit-10 single-colony seed position,
// unchanged. COLONY_PLACEMENT_MARGIN keeps a freshly spiralled queen (and
// its starting workers, offset up to ~100 units away) comfortably inside
// world bounds rather than clamped flush against an edge.
export const COLONY_SPACING = 300;
export const COLONY_PLACEMENT_MARGIN = 200;

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

// Deterministic seed spread across the whole world so aphids are visibly
// everywhere, not clustered near the nest. Fixed positions, not randomised —
// same rationale as RESOURCE_NODES: a fresh seed and a test run must be
// reproducible. Expressed as fractions of WORLD so they stay in-bounds
// regardless of world size.
export const APHID_SEED_POSITIONS: { x: number; y: number }[] = [
  { x: WORLD.width * 0.05, y: WORLD.height * 0.05 },
  { x: WORLD.width * 0.95, y: WORLD.height * 0.05 },
  { x: WORLD.width * 0.05, y: WORLD.height * 0.95 },
  { x: WORLD.width * 0.95, y: WORLD.height * 0.95 },
  { x: WORLD.width * 0.5, y: WORLD.height * 0.07 },
  { x: WORLD.width * 0.5, y: WORLD.height * 0.93 },
  { x: WORLD.width * 0.07, y: WORLD.height * 0.5 },
  { x: WORLD.width * 0.93, y: WORLD.height * 0.5 },
  { x: WORLD.width * 0.27, y: WORLD.height * 0.27 },
  { x: WORLD.width * 0.73, y: WORLD.height * 0.27 },
  { x: WORLD.width * 0.27, y: WORLD.height * 0.73 },
  { x: WORLD.width * 0.73, y: WORLD.height * 0.73 },
  { x: WORLD.width * 0.5, y: WORLD.height * 0.33 },
  { x: WORLD.width * 0.33, y: WORLD.height * 0.63 },
];

// Stage 6: creature health. Keyed by species so a future species needs only
// a new map entry, not a schema change (health/maxHealth columns are
// already species-agnostic). Placeholder value: a single worker kills an
// aphid in 3 hits (~3s at WORKER_ATTACK_COOLDOWN=1s), fast enough that
// realtime/death tests stay quick. Balancing isn't a priority this stage.
export const APHID_MAX_HEALTH = 30;
export const SPECIES_MAX_HEALTH: Record<string, number> = {
  aphid: APHID_MAX_HEALTH,
};

// Protein credited to the colony's economy once a carcass is fully
// harvested (split across however many gather claims it takes at
// GATHER_YIELD per claim).
export const APHID_PROTEIN_VALUE = 30;

// Chosen comfortably above MIN_SEPARATION (20) so the separation force can
// never prevent a worker reaching attack range — same scale as GATHER_RANGE
// (30). Damage/cooldown are placeholders: APHID_MAX_HEALTH / WORKER_ATTACK_DAMAGE
// hits to kill, WORKER_ATTACK_COOLDOWN seconds apart.
export const WORKER_ATTACK_RANGE = 30;
export const WORKER_ATTACK_DAMAGE = 10;
export const WORKER_ATTACK_COOLDOWN = 1;
