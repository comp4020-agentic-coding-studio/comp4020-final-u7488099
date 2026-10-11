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

// Picks the nearest node of a type to a given worker, so travel-based tests
// don't wait on a trip across the whole 3000x3000 world.
function closestNode(state: any, worker: any, resourceType: string) {
  const nodes = state.resourceNodes.filter((n: any) => n.resourceType === resourceType);
  if (nodes.length === 0) throw new Error(`seed has no ${resourceType} node`);
  return nodes.reduce((best: any, n: any) =>
    Math.hypot(n.x - worker.x, n.y - worker.y) < Math.hypot(best.x - worker.x, best.y - worker.y) ? n : best,
  );
}

async function waitForResourceIncrease(resourceType: string, baseline: number, timeoutMs = 15000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let state = await getState();
  while (state.colony.resources[resourceType] <= baseline && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    state = await getState();
  }
  return state;
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

it("gathering requires travel: no instant credit on issue, then the clicked node's resource type is credited on arrival", async () => {
  const before = await getState();
  const worker = before.workers[0];
  const node = closestNode(before, worker, "sugar");

  const res = await fetch(new URL("/api/command/gather", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workerIds: [worker.id], resourceId: node.id }),
  });
  expect(res.status).toBe(200);
  const justIssued = await res.json();
  // Issuing the command only starts travel — it must not credit anything yet.
  expect(justIssued.colony.resources.sugar).toBe(before.colony.resources.sugar);

  const after = await waitForResourceIncrease("sugar", before.colony.resources.sugar);
  expect(after.colony.resources.sugar).toBeGreaterThan(before.colony.resources.sugar);
  expect(after.colony.resources.protein).toBe(before.colony.resources.protein);
  expect(after.colony.resources.biomass).toBe(before.colony.resources.biomass);

  const refetched = await getState();
  expect(refetched.colony.resources.sugar).toBe(after.colony.resources.sugar);
});

it("rejects a gather command for a worker or resource that doesn't exist, with no instant credit either way", async () => {
  const before = await getState();
  const res = await fetch(new URL("/api/command/gather", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workerIds: [999999], resourceId: 999999 }),
  });
  expect(res.status).toBe(400);

  const after = await getState();
  expect(after.colony.resources).toEqual(before.colony.resources);
});

async function gatherProteinUntil(targetProtein: number): Promise<void> {
  let state = await getState();
  const workerId = state.workers[0].id;
  const deadline = Date.now() + 30000;
  while (state.colony.resources.protein < targetProtein && Date.now() < deadline) {
    const worker = state.workers.find((w: any) => w.id === workerId);
    const node = closestNode(state, worker, "protein");
    await fetch(new URL("/api/command/gather", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerIds: [workerId], resourceId: node.id }),
    });
    await new Promise((r) => setTimeout(r, 250));
    state = await getState();
  }
  if (state.colony.resources.protein < targetProtein) {
    throw new Error(`gatherProteinUntil(${targetProtein}) timed out at ${state.colony.resources.protein}`);
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
