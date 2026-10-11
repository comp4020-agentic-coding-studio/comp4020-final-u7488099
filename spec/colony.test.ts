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

it("a move command with several valid worker ids moves all of them", async () => {
  const before = await getState();
  const movers = before.workers.slice(0, 2);
  const target = { x: Math.min(before.world.width - 10, before.colony.queenX + 400), y: before.colony.queenY };

  const res = await fetch(new URL("/api/command/move", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workerIds: movers.map((w: any) => w.id), x: target.x, y: target.y }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.errors).toBeUndefined();

  // Movement is continuous and server-driven — just confirm both workers
  // are travelling, not that they've arrived.
  await new Promise((r) => setTimeout(r, 300));
  const moved = await getState();
  for (const worker of movers) {
    const current = moved.workers.find((w: any) => w.id === worker.id);
    expect(current.x !== worker.x || current.y !== worker.y).toBe(true);
  }
});

it("a move command with one valid and one invalid id still moves the valid worker and names the invalid one", async () => {
  const before = await getState();
  const worker = before.workers[0];
  const target = { x: Math.min(before.world.width - 10, worker.x + 400), y: worker.y };

  const res = await fetch(new URL("/api/command/move", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workerIds: [worker.id, 999999], x: target.x, y: target.y }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.errors).toEqual({ 999999: "no such worker" });

  await new Promise((r) => setTimeout(r, 300));
  const after = await getState();
  const current = after.workers.find((w: any) => w.id === worker.id);
  expect(current.x !== worker.x || current.y !== worker.y).toBe(true);
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

// Stage 4: a claim no longer credits the colony instantly — the worker has
// to carry the payload home and deposit it, roughly doubling the round trip
// versus the old single-leg travel. A worker that's already carrying/
// returning also rejects a re-issued gather command (see CLAUDE.md), so this
// polls for every currently-idle (not carrying) worker each cycle and sends
// it after protein, rather than blindly re-posting to one fixed worker id
// that might now be busy returning a previous claim.
async function gatherProteinUntil(targetProtein: number): Promise<void> {
  let state = await getState();
  const deadline = Date.now() + 45000;
  while (state.colony.resources.protein < targetProtein && Date.now() < deadline) {
    const idleWorkers = state.workers.filter((w: any) => !w.carrying);
    for (const worker of idleWorkers) {
      const node = closestNode(state, worker, "protein");
      await fetch(new URL("/api/command/gather", baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerIds: [worker.id], resourceId: node.id }),
      });
    }
    await new Promise((r) => setTimeout(r, 250));
    state = await getState();
  }
  if (state.colony.resources.protein < targetProtein) {
    throw new Error(`gatherProteinUntil(${targetProtein}) timed out at ${state.colony.resources.protein}`);
  }
}

it("reproduce spends protein and adds a worker at the queen's position", { timeout: 60000 }, async () => {
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

it("a worker that's carrying resources home rejects a new move command, but a free worker in the same batch still moves", async () => {
  const before = await getState();
  const [busyCandidate, freeWorker] = before.workers;
  const sugarNode = closestNode(before, busyCandidate, "sugar");

  await fetch(new URL("/api/command/gather", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workerIds: [busyCandidate.id], resourceId: sugarNode.id }),
  });

  const deadline = Date.now() + 15000;
  let state = await getState();
  let busyWorker = state.workers.find((w: any) => w.id === busyCandidate.id);
  while (!busyWorker.carrying && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    state = await getState();
    busyWorker = state.workers.find((w: any) => w.id === busyCandidate.id);
  }
  expect(busyWorker.carrying).toBeTruthy();

  const target = { x: Math.min(before.world.width - 10, freeWorker.x + 400), y: freeWorker.y };
  const res = await fetch(new URL("/api/command/move", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workerIds: [busyWorker.id, freeWorker.id], x: target.x, y: target.y }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.errors).toEqual({ [busyWorker.id]: "worker is busy returning resources" });

  await new Promise((r) => setTimeout(r, 300));
  const after = await getState();
  const movedFreeWorker = after.workers.find((w: any) => w.id === freeWorker.id);
  expect(movedFreeWorker.x !== freeWorker.x || movedFreeWorker.y !== freeWorker.y).toBe(true);
});

// Stage 5: H — the authoritative state surface exposes the neutral creature
// population (currently just aphids) alongside workers/resourceNodes, with
// no separate endpoint or protocol.
it("H: state includes the seeded aphid population, each shaped {id, species, x, y} within world bounds", async () => {
  const state = await getState();

  expect(Array.isArray(state.creatures)).toBe(true);
  expect(state.creatures.length).toBeGreaterThanOrEqual(10);
  for (const creature of state.creatures) {
    expect(typeof creature.id).toBe("number");
    expect(creature.species).toBe("aphid");
    expect(creature.x).toBeGreaterThanOrEqual(0);
    expect(creature.x).toBeLessThanOrEqual(state.world.width);
    expect(creature.y).toBeGreaterThanOrEqual(0);
    expect(creature.y).toBeLessThanOrEqual(state.world.height);
  }

  // Stable identity across requests — same population, not re-seeded per call.
  const again = await getState();
  expect(again.creatures.map((c: any) => c.id).sort()).toEqual(state.creatures.map((c: any) => c.id).sort());
});
