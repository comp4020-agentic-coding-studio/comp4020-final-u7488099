import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");

// Stage 1's three initial resource types. Not imported from src/server/
// balance.ts on purpose — this spec checks the app over HTTP as a black box,
// same as the rest of this file.
const RESOURCE_TYPES = ["sugar", "protein", "biomass"];

async function getState() {
  const res = await fetch(new URL("/api/state", baseUrl));
  expect(res.status).toBe(200);
  return res.json();
}

function findNode(state: any, resourceType: string) {
  const node = state.resourceNodes.find((n: any) => n.resourceType === resourceType);
  if (!node) throw new Error(`seed has no ${resourceType} node`);
  return node;
}

it("seeds a large continuous world with one colony, 3 workers near the queen, and several resource types", async () => {
  const state = await getState();

  expect(state.world.width).toBeGreaterThanOrEqual(1000);
  expect(state.world.height).toBeGreaterThanOrEqual(1000);

  expect(typeof state.colony.queenX).toBe("number");
  expect(typeof state.colony.queenY).toBe("number");
  expect(state.colony.queenX).toBeGreaterThanOrEqual(0);
  expect(state.colony.queenX).toBeLessThanOrEqual(state.world.width);
  expect(state.colony.queenY).toBeGreaterThanOrEqual(0);
  expect(state.colony.queenY).toBeLessThanOrEqual(state.world.height);

  for (const type of RESOURCE_TYPES) {
    expect(state.colony.resources[type]).toBe(0);
  }

  expect(state.workers).toHaveLength(3);
  for (const worker of state.workers) {
    expect(Math.hypot(worker.x - state.colony.queenX, worker.y - state.colony.queenY)).toBeLessThanOrEqual(100);
  }

  expect(state.resourceNodes.length).toBeGreaterThan(0);
  const seenTypes = new Set(state.resourceNodes.map((n: any) => n.resourceType));
  for (const type of RESOURCE_TYPES) {
    expect(seenTypes.has(type)).toBe(true);
  }
  for (const node of state.resourceNodes) {
    expect(node.x).toBeGreaterThanOrEqual(0);
    expect(node.x).toBeLessThanOrEqual(state.world.width);
    expect(node.y).toBeGreaterThanOrEqual(0);
    expect(node.y).toBeLessThanOrEqual(state.world.height);
  }
});

it("gathering credits the colony's bucket matching the clicked node's resource type (transitional, pre-travel)", async () => {
  const before = await getState();
  const worker = before.workers[0];
  const node = findNode(before, "biomass");

  const res = await fetch(new URL("/api/gather", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workerId: worker.id, nodeId: node.id }),
  });
  expect(res.status).toBe(200);
  const after = await res.json();

  expect(after.colony.resources.biomass).toBeGreaterThan(before.colony.resources.biomass);
  expect(after.colony.resources.sugar).toBe(before.colony.resources.sugar);
  expect(after.colony.resources.protein).toBe(before.colony.resources.protein);

  const refetched = await getState();
  expect(refetched.colony.resources.biomass).toBe(after.colony.resources.biomass);
});

it("rejects gather from a worker or node that doesn't exist", async () => {
  const res = await fetch(new URL("/api/gather", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workerId: 999999, nodeId: 999999 }),
  });
  expect(res.status).toBe(400);
});

async function gatherProteinUntil(targetProtein: number): Promise<void> {
  let state = await getState();
  const proteinNode = findNode(state, "protein");
  while (state.colony.resources.protein < targetProtein) {
    const res = await fetch(new URL("/api/gather", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerId: state.workers[0].id, nodeId: proteinNode.id }),
    });
    state = await res.json();
  }
}

it("reproduce spends protein and adds a worker at the queen's position", async () => {
  await gatherProteinUntil(50);
  const before = await getState();

  const res = await fetch(new URL("/api/reproduce", baseUrl), { method: "POST" });
  expect(res.status).toBe(200);
  const after = await res.json();

  expect(after.workers).toHaveLength(before.workers.length + 1);
  expect(after.colony.resources.protein).toBe(before.colony.resources.protein - 50);

  const newWorker = after.workers.at(-1);
  expect(newWorker).toMatchObject({ x: after.colony.queenX, y: after.colony.queenY });
});

it("rejects reproduce with insufficient protein, without mutating state", async () => {
  // Runs right after the test above, which gathers to exactly 50 and spends
  // exactly 50 reproducing — protein is back below REPRODUCE_COST.
  const before = await getState();
  expect(before.colony.resources.protein).toBeLessThan(50);

  const res = await fetch(new URL("/api/reproduce", baseUrl), { method: "POST" });
  expect(res.status).toBe(400);

  const after = await getState();
  expect(after.workers).toHaveLength(before.workers.length);
  expect(after.colony.resources.protein).toBe(before.colony.resources.protein);
});

it("still has the mutated resource count and worker count on a fresh request", async () => {
  // SQLite-backed, not in-memory: a gather, then a fresh GET as its own
  // request should see what the earlier request wrote. This can only prove
  // cross-request persistence, not cross-restart — that's verified manually
  // against a running container (see PROCESS.md).
  const before = await getState();
  await gatherProteinUntil(before.colony.resources.protein + 10);

  const mutated = await getState();
  expect(mutated.colony.resources.protein).toBeGreaterThan(before.colony.resources.protein);

  const stillThere = await getState();
  expect(stillThere.colony.resources.protein).toBe(mutated.colony.resources.protein);
  expect(stillThere.workers).toHaveLength(mutated.workers.length);
});
