export const WORLD = {
  width: 3000,
  height: 3000,
};

export const STARTING_WORKERS = 3;

export const RESOURCE_TYPES = ["sugar", "protein", "biomass"] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

// Stage 1 seed: fixed, deterministic positions spread across the world so it
// visibly exceeds any one viewport. Not randomised — a fresh seed, and a
// test run, must be reproducible. `amount`/`maxAmount` are stored now but
// unused by today's transitional `gather()`; Stage 4 adds real depletion.
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

export const GATHER_YIELD = 10;
export const REPRODUCE_COST = 50;
