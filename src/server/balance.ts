export const WORLD = {
  width: 10,
  height: 10,
  foodNodes: [
    [1, 1],
    [8, 1],
    [1, 8],
    [8, 8],
    [4, 0],
  ] as const,
};

export const STARTING_WORKERS = 3;
export const GATHER_YIELD = 10;
export const REPRODUCE_COST = 50;
