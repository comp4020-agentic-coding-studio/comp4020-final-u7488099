export const WORLD = {
  width: 3000,
  height: 3000,
};

export const STARTING_WORKERS = 3;

export const RESOURCE_TYPES = ["sugar", "protein", "biomass"] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

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
  // sugar/nectar: small, plentiful, doesn't deplete.
  { x: 1200, y: 1200, resourceType: "sugar", amount: null, maxAmount: null },
  { x: 1800, y: 1200, resourceType: "sugar", amount: null, maxAmount: null },
  { x: 1200, y: 1800, resourceType: "sugar", amount: null, maxAmount: null },
  { x: 1800, y: 1800, resourceType: "sugar", amount: null, maxAmount: null },
  { x: 1500, y: 900, resourceType: "sugar", amount: null, maxAmount: null },
  { x: 1500, y: 2100, resourceType: "sugar", amount: null, maxAmount: null },
  // protein: medium-sized prey, finite.
  { x: 700, y: 1500, resourceType: "protein", amount: 200, maxAmount: 200 },
  { x: 2300, y: 1500, resourceType: "protein", amount: 200, maxAmount: 200 },
  { x: 1500, y: 700, resourceType: "protein", amount: 200, maxAmount: 200 },
  { x: 1500, y: 2300, resourceType: "protein", amount: 200, maxAmount: 200 },
  // biomass: large, rare, finite — placed at the far corners to make the
  // world's size obvious.
  { x: 300, y: 300, resourceType: "biomass", amount: 500, maxAmount: 500 },
  { x: 2700, y: 2700, resourceType: "biomass", amount: 500, maxAmount: 500 },
];

// How much a single successful claim credits, and how much it decrements a
// finite node's remaining amount (capped at whatever's left — see
// attemptGatherClaim in simulation.ts).
export const GATHER_YIELD = 10;
// How close a gathering worker must get to a resource's centre before a
// claim is attempted. Bigger than any NODE_RADIUS so workers visibly stop at
// the node's edge rather than overlapping its centre.
export const GATHER_RANGE = 30;
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

// Simulation cadence: ticking faster than it broadcasts is deliberate — the
// authoritative position updates smoothly in memory even though clients only
// see a new frame every BROADCAST_HZ. See CLAUDE.md.
export const SIMULATION = {
  tickHz: 10,
  broadcastHz: 5,
  checkpointIntervalMs: 5000,
};
