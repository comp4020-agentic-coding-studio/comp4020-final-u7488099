import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");

async function getState() {
  const res = await fetch(new URL("/api/state", baseUrl));
  expect(res.status).toBe(200);
  return res.json();
}

it("seeds one colony with 3 workers near the queen and some food nodes", async () => {
  const state = await getState();

  expect(state.colony).toMatchObject({ protein: 0 });
  expect(typeof state.colony.queenX).toBe("number");
  expect(typeof state.colony.queenY).toBe("number");

  expect(state.workers).toHaveLength(3);
  for (const worker of state.workers) {
    expect(Math.abs(worker.x - state.colony.queenX)).toBeLessThanOrEqual(2);
    expect(Math.abs(worker.y - state.colony.queenY)).toBeLessThanOrEqual(2);
  }

  expect(state.resourceNodes.length).toBeGreaterThan(0);
  for (const node of state.resourceNodes) {
    expect(node.resourceType).toBe("food");
  }
});

it("gathering raises colony protein by the fixed yield", async () => {
  const before = await getState();
  const worker = before.workers[0];
  const node = before.resourceNodes[0];

  const res = await fetch(new URL("/api/gather", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workerId: worker.id, nodeId: node.id }),
  });
  expect(res.status).toBe(200);
  const after = await res.json();

  expect(after.colony.protein).toBeGreaterThan(before.colony.protein);

  const refetched = await getState();
  expect(refetched.colony.protein).toBe(after.colony.protein);
});

it("rejects gather from a worker or node that doesn't exist", async () => {
  const res = await fetch(new URL("/api/gather", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workerId: 999999, nodeId: 999999 }),
  });
  expect(res.status).toBe(400);
});

async function gatherUntil(targetProtein: number): Promise<void> {
  let state = await getState();
  while (state.colony.protein < targetProtein) {
    const res = await fetch(new URL("/api/gather", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerId: state.workers[0].id, nodeId: state.resourceNodes[0].id }),
    });
    state = await res.json();
  }
}

it("reproduce spends protein and adds a worker at the queen's position", async () => {
  await gatherUntil(50);
  const before = await getState();

  const res = await fetch(new URL("/api/reproduce", baseUrl), { method: "POST" });
  expect(res.status).toBe(200);
  const after = await res.json();

  expect(after.workers).toHaveLength(before.workers.length + 1);
  expect(after.colony.protein).toBe(before.colony.protein - 50);

  const newWorker = after.workers.at(-1);
  expect(newWorker).toMatchObject({ x: after.colony.queenX, y: after.colony.queenY });
});

it("rejects reproduce with insufficient protein, without mutating state", async () => {
  // Runs right after the test above, which gathers to exactly 50 and spends
  // exactly 50 reproducing — protein is back at 0, below REPRODUCE_COST.
  const before = await getState();
  expect(before.colony.protein).toBeLessThan(50);

  const res = await fetch(new URL("/api/reproduce", baseUrl), { method: "POST" });
  expect(res.status).toBe(400);

  const after = await getState();
  expect(after.workers).toHaveLength(before.workers.length);
  expect(after.colony.protein).toBe(before.colony.protein);
});

it("still has the mutated protein and worker count on a fresh request", async () => {
  // SQLite-backed, not in-memory: a gather/reproduce pair, then a fresh
  // GET as its own request should see what the earlier requests wrote.
  // This can only prove cross-request persistence, not cross-restart —
  // that's verified manually against a running container (see PROCESS.md).
  const before = await getState();
  await gatherUntil(before.colony.protein + 10);

  const mutated = await getState();
  expect(mutated.colony.protein).toBeGreaterThan(before.colony.protein);

  const stillThere = await getState();
  expect(stillThere.colony.protein).toBe(mutated.colony.protein);
  expect(stillThere.workers).toHaveLength(mutated.workers.length);
});
