import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");

// Stage 1's three initial resource types. Not imported from src/server/
// balance.ts on purpose — this spec checks the app over HTTP as a black box,
// same as the rest of this file.
const RESOURCE_TYPES = ["sugar", "protein", "biomass"];

// Stage 6b: a fresh colony starts with exactly one reproduction's worth of
// protein already deposited (enough to test reproduction immediately,
// without a hunt-and-carry round trip first) — see balance.ts's
// STARTING_PROTEIN. Sugar/biomass still start at 0.
const STARTING_PROTEIN = 50;

// Stage 6b: reproducing a worker costs exactly one STARTING_PROTEIN's worth
// of protein — same literal, named separately here since Stage 8's
// soft-lock regression test reasons about it as a cost, not a starting
// balance. Not imported from balance.ts for the same black-box reason as
// every other constant in this file.
const REPRODUCE_COST = 50;

// Crit 10: every request in this file now carries a session cookie, so the
// whole suite exercises exactly one colony throughout (one consistent
// browser profile), matching this file's pre-Crit-10 single-colony
// assumptions. Duplicated from spec/multiplayer.test.ts's createSession()
// rather than imported — that file is intentionally self-contained and
// deliberately never touched to adapt other tests. See CLAUDE.md.
function createSession() {
  let cookie: string | null = null;
  return async function request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (cookie) headers.set("cookie", cookie);
    const res = await fetch(new URL(path, baseUrl), { ...init, headers });
    const setCookie = (res.headers as any).getSetCookie?.() ?? [];
    for (const header of setCookie) {
      cookie = cookie ? `${cookie}; ${header.split(";")[0]}` : header.split(";")[0];
    }
    return res;
  };
}

const request = createSession();

async function getState() {
  const res = await request("/api/state");
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

// Stage 10: fog of war means GET /api/state only returns resource nodes
// within the caller's own vision radius — a freshly-seeded, unscouted colony
// sees none of them. Duplicated (not imported) from the identical idiom in
// spec/realtime.test.ts/multiplayer.test.ts/evolution.test.ts, per this
// file's own header comment on why these specs stay self-contained.
async function dispatchGridSearch(state: any, wave: number): Promise<void> {
  if (state.workers.length === 0) return;
  const { width, height } = state.world;
  const GRID = 4;
  const waypoints: { x: number; y: number }[] = [];
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      waypoints.push({
        x: Math.round(((gx + 0.5) / GRID) * width),
        y: Math.round(((gy + 0.5) / GRID) * height),
      });
    }
  }
  await Promise.all(
    state.workers.map((w: any, i: number) => {
      const point = waypoints[(wave * state.workers.length + i) % waypoints.length];
      return request("/api/command/move", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerIds: [w.id], ...point }),
      });
    }),
  );
}

// Keeps re-dispatching a widening grid search until `isFound` is true — used
// when we need vision of some resource type the seed may have placed
// anywhere in the (large) world relative to this colony's queen.
async function discoverUntil(
  state: any,
  isFound: (s: any) => boolean,
  timeoutMs = 60000,
): Promise<any> {
  if (isFound(state)) return state;
  const REDISPATCH_MS = 7000;
  let wave = 0;
  let current = state;
  await dispatchGridSearch(current, wave);
  let lastDispatch = Date.now();

  const deadline = Date.now() + timeoutMs;
  while (!isFound(current) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    current = await getState();
    if (!isFound(current) && Date.now() - lastDispatch > REDISPATCH_MS) {
      wave += 1;
      await dispatchGridSearch(current, wave);
      lastDispatch = Date.now();
    }
  }
  return current;
}

async function discoverResourceType(state: any, resourceType: string, timeoutMs = 60000): Promise<any> {
  return discoverUntil(state, (s: any) => s.resourceNodes.some((n: any) => n.resourceType === resourceType), timeoutMs);
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

// Stage 10: fog of war means a fresh colony's own vision only covers the
// small area around its queen/starting workers — the seeded world-wide
// creature population (and specifically a spider) is no longer guaranteed
// to already be visible. Sends every one of the colony's own workers on a
// patrol around a grid of waypoints spread across the world, re-dispatching
// them to a fresh wave of points periodically, and polls /api/state until
// enough creatures (optionally of a specific species) come into view —
// rather than assuming the full seed is visible from a static starting
// position, or that a single fixed destination is guaranteed to cross paths
// with a wandering creature.
async function discoverCreatures(
  req: ReturnType<typeof createSession>,
  state: any,
  opts: { minCount?: number; needSpecies?: string; timeoutMs?: number } = {},
): Promise<any> {
  const { minCount = 1, needSpecies, timeoutMs = 60000 } = opts;
  const { width, height } = state.world;
  const GRID = 4;
  const waypoints: { x: number; y: number }[] = [];
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      waypoints.push({
        x: Math.round(((gx + 0.5) / GRID) * width),
        y: Math.round(((gy + 0.5) / GRID) * height),
      });
    }
  }

  const satisfied = (s: any) =>
    s.creatures.length >= minCount && (!needSpecies || s.creatures.some((c: any) => c.species === needSpecies));

  const dispatch = async (s: any, wave: number) => {
    if (s.workers.length === 0) return;
    await Promise.all(
      s.workers.map((w: any, i: number) => {
        const point = waypoints[(wave * s.workers.length + i) % waypoints.length];
        return req("/api/command/move", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workerIds: [w.id], ...point }),
        });
      }),
    );
  };

  const REDISPATCH_MS = 7000;
  let wave = 0;
  let current = state;
  await dispatch(current, wave);
  let lastDispatch = Date.now();

  const deadline = Date.now() + timeoutMs;
  while (!satisfied(current) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    current = await (await req("/api/state")).json();
    if (!satisfied(current) && Date.now() - lastDispatch > REDISPATCH_MS) {
      wave += 1;
      await dispatch(current, wave);
      lastDispatch = Date.now();
    }
  }
  return current;
}

// Stage 10: halts every one of a colony's own workers exactly where they
// stand, by commanding each to "move" to its own current position — used
// right before a stability check that must see a genuinely unmoving fog
// view across two back-to-back /api/state calls.
async function freezeWorkers(req: ReturnType<typeof createSession>, state: any): Promise<void> {
  await Promise.all(
    state.workers.map((w: any) =>
      req("/api/command/move", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerIds: [w.id], x: w.x, y: w.y }),
      }),
    ),
  );
}

it(
  "seeds a large continuous world with one colony, 3 workers near the queen, and several resource types",
  async () => {
  let state = await getState();

  expect(state.world.width).toBeGreaterThanOrEqual(1000);
  expect(state.world.height).toBeGreaterThanOrEqual(1000);

  expect(typeof state.colony.queenX).toBe("number");
  expect(typeof state.colony.queenY).toBe("number");
  expect(state.colony.queenX).toBeGreaterThanOrEqual(0);
  expect(state.colony.queenX).toBeLessThanOrEqual(state.world.width);
  expect(state.colony.queenY).toBeGreaterThanOrEqual(0);
  expect(state.colony.queenY).toBeLessThanOrEqual(state.world.height);

  for (const type of RESOURCE_TYPES) {
    expect(state.colony.resources[type]).toBe(type === "protein" ? STARTING_PROTEIN : 0);
  }

  expect(state.workers).toHaveLength(3);
  for (const worker of state.workers) {
    expect(Math.hypot(worker.x - state.colony.queenX, worker.y - state.colony.queenY)).toBeLessThanOrEqual(100);
  }

  // Stage 10: fog means the initial, unscouted response only shows resource
  // nodes near the queen — scout toward each type still missing before
  // checking the seed actually contains all three.
  for (const type of RESOURCE_TYPES) {
    state = await discoverResourceType(state, type);
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
  },
  60000,
);

it(
  "gathering requires travel: no instant credit on issue, then the clicked node's resource type is credited on arrival",
  async () => {
  let before = await getState();
  before = await discoverResourceType(before, "sugar");
  const worker = before.workers[0];
  const node = closestNode(before, worker, "sugar");

  const res = await request("/api/command/gather", {
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
  },
  60000,
);

it("a move command with several valid worker ids moves all of them", async () => {
  const before = await getState();
  const movers = before.workers.slice(0, 2);
  const target = { x: Math.min(before.world.width - 10, before.colony.queenX + 400), y: before.colony.queenY };

  const res = await request("/api/command/move", {
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

  const res = await request("/api/command/move", {
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
  const res = await request("/api/command/gather", {
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
  // Stage 10: fog means a fresh colony may not yet have a protein node in
  // view — scout for one before entering the claim loop below.
  state = await discoverResourceType(state, "protein");
  const deadline = Date.now() + 45000;
  while (state.colony.resources.protein < targetProtein && Date.now() < deadline) {
    const idleWorkers = state.workers.filter((w: any) => !w.carrying);
    for (const worker of idleWorkers) {
      const node = closestNode(state, worker, "protein");
      await request("/api/command/gather", {
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

it("reproduce spends protein and adds a worker at the queen's position", async () => {
  await gatherProteinUntil(50);
  const before = await getState();

  const res = await request("/api/reproduce", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ caste: "worker" }),
  });
  expect(res.status).toBe(200);
  const after = await res.json();

  expect(after.workers).toHaveLength(before.workers.length + 1);
  expect(after.colony.resources.protein).toBe(before.colony.resources.protein - 50);

  const newWorker = after.workers.at(-1);
  expect(newWorker).toMatchObject({ x: after.colony.queenX, y: after.colony.queenY });
  // Stage 7: a freshly hatched worker starts at full health, same precedent
  // as freshly seeded aphids.
  expect(newWorker.health).toBe(newWorker.maxHealth);
  expect(newWorker.health).toBeGreaterThan(0);
}, 60000);

it("rejects reproduce with insufficient protein, without mutating state", async () => {
  // Runs right after the test above, which gathers to exactly 50 and spends
  // exactly 50 reproducing — protein is back below REPRODUCE_COST.
  const before = await getState();
  expect(before.colony.resources.protein).toBeLessThan(50);

  const res = await request("/api/reproduce", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ caste: "worker" }),
  });
  expect(res.status).toBe(400);

  const after = await getState();
  expect(after.workers).toHaveLength(before.workers.length);
  expect(after.colony.resources.protein).toBe(before.colony.resources.protein);
});

it(
  "still has the mutated resource count and worker count on a fresh request",
  async () => {
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
  },
  60000,
);

it(
  "a worker that's carrying resources home rejects a new move command, but a free worker in the same batch still moves",
  async () => {
    // The previous two tests' gatherProteinUntil calls can leave a worker still
    // mid-round-trip when they exit (they only wait for the protein total to
    // rise, not for every in-flight gather to finish) — wait for at least 2
    // genuinely idle workers before picking this test's two candidates, rather
    // than assuming before.workers[0]/[1] are both free. Stage 9's gather
    // channel (GATHER_DURATION, see evolution.ts) adds real latency to every
    // round trip on top of travel time, so this deadline is longer than it
    // would need to be pre-Stage-9.
    let before = await getState();
    const idleDeadline = Date.now() + 30000;
    while (before.workers.filter((w: any) => !w.carrying).length < 2 && Date.now() < idleDeadline) {
      await new Promise((r) => setTimeout(r, 200));
      before = await getState();
    }
    before = await discoverResourceType(before, "sugar");
    const [busyCandidate, freeWorker] = before.workers.filter((w: any) => !w.carrying);
    const sugarNode = closestNode(before, busyCandidate, "sugar");

    // freeWorker looked idle (not carrying) in the snapshot above, but it may
    // still have a stale in-flight gather command from an earlier test's
    // gatherProteinUntil (carrying is null until arrival/claim, so "not
    // carrying" alone doesn't mean "no command"). Issuing it a move to its own
    // current position unconditionally overwrites any such command and settles
    // it before the real assertion below, so it can't suddenly start carrying
    // mid-test.
    await request("/api/command/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerIds: [freeWorker.id], x: freeWorker.x, y: freeWorker.y }),
    });

    await request("/api/command/gather", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerIds: [busyCandidate.id], resourceId: sugarNode.id }),
    });

    const deadline = Date.now() + 30000;
    let state = await getState();
    let busyWorker = state.workers.find((w: any) => w.id === busyCandidate.id);
    while (!busyWorker.carrying && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      state = await getState();
      busyWorker = state.workers.find((w: any) => w.id === busyCandidate.id);
    }
    expect(busyWorker.carrying).toBeTruthy();

    const target = { x: Math.min(before.world.width - 10, freeWorker.x + 400), y: freeWorker.y };
    const res = await request("/api/command/move", {
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
  },
  60000,
);

// Stage 5: H — the authoritative state surface exposes the neutral/hostile
// creature population (aphids and, since Stage 7, spiders) alongside
// workers/resourceNodes, with no separate endpoint or protocol.
it(
  "H: state includes the seeded creature population, each shaped {id, species, x, y} within world bounds",
  async () => {
    // Stage 10: fog of war means this colony's vision starts out small — send
    // its workers out to scout before expecting the full seeded population to
    // be visible.
    let state = await discoverCreatures(request, await getState(), { minCount: 10 });

    expect(Array.isArray(state.creatures)).toBe(true);
    expect(state.creatures.length).toBeGreaterThanOrEqual(10);
    for (const creature of state.creatures) {
      expect(typeof creature.id).toBe("number");
      expect(["aphid", "spider"]).toContain(creature.species);
      expect(creature.x).toBeGreaterThanOrEqual(0);
      expect(creature.x).toBeLessThanOrEqual(state.world.width);
      expect(creature.y).toBeGreaterThanOrEqual(0);
      expect(creature.y).toBeLessThanOrEqual(state.world.height);
    }

    // Stable identity across requests — same population, not re-seeded per
    // call. Freeze workers first so fog visibility itself doesn't shift
    // between these two back-to-back reads.
    await freezeWorkers(request, state);
    state = await getState();
    const again = await getState();
    expect(again.creatures.map((c: any) => c.id).sort()).toEqual(state.creatures.map((c: any) => c.id).sort());
  },
  90000,
);

// Stage 6: a valid attack dispatches like any other batch command (200,
// per-id error shape for bad ids); the worker then visibly chases the
// creature, same as a move/gather command's follow-up GET pattern above.
it("dispatches an attack command: valid ids succeed and the worker chases the aphid; invalid ids report per-id errors", async () => {
  const before = await getState();
  const worker = before.workers.find((w: any) => !w.carrying) ?? before.workers[0];
  const creature = before.creatures[0];

  const badRes = await request("/api/command/attack", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workerIds: [worker.id, 999999], creatureId: creature.id }),
  });
  expect(badRes.status).toBe(200);
  const badBody = await badRes.json();
  expect(badBody.errors).toEqual({ 999999: "no such worker" });

  const allBadRes = await request("/api/command/attack", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workerIds: [999999], creatureId: creature.id }),
  });
  expect(allBadRes.status).toBe(400);

  // Confirm the dispatch actually started a chase: poll until the worker has
  // moved toward the creature's last known position (or already attacked it
  // if it started nearby), rather than asserting exact distance decrease —
  // the aphid itself may wander during the poll.
  const deadline = Date.now() + 10000;
  let moved = false;
  let state = before;
  while (!moved && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    state = await getState();
    const current = state.workers.find((w: any) => w.id === worker.id);
    if (current.x !== worker.x || current.y !== worker.y) moved = true;
  }
  expect(moved).toBe(true);
});

// Stage 6: the full hunt -> kill -> carcass -> gather -> deposit flow, driven
// entirely over HTTP — no direct simulation access, matching the rest of
// this file's black-box style.
it(
  "killing an aphid leaves a carcass that can be gathered and deposited like any other resource",
  async () => {
    const before = await getState();
    const creature = before.creatures[0];
    // Stage 10 bugfix: fog of war means this colony's own view of `creature`
    // only exists because *some* own worker is currently within vision range
    // of it. Picking an arbitrary non-carrying worker (instead of the one
    // nearest to the creature) could pick one stationed far away — the long
    // travel time to close to attack range left the creature with no vision
    // source covering it for many frames in between, which the "disappeared
    // from state" poll below misread as death, producing no carcass at all.
    // Picking the nearest own worker keeps the creature continuously visible
    // to this same session throughout the fight.
    const eligibleWorkers = before.workers.filter((w: any) => !w.carrying);
    const workerPool = eligibleWorkers.length > 0 ? eligibleWorkers : before.workers;
    const worker = workerPool.reduce((best: any, w: any) =>
      Math.hypot(w.x - creature.x, w.y - creature.y) < Math.hypot(best.x - creature.x, best.y - creature.y) ? w : best,
    );
    const baselineProtein = before.colony.resources.protein;
    // The creature wanders (and is chased) before it dies, so its death
    // position won't match where it started — identify the new carcass by
    // which item-node id is new, not by position.
    const existingItemIds = new Set(
      before.resourceNodes.filter((n: any) => n.kind === "item").map((n: any) => n.id),
    );

    const attackRes = await request("/api/command/attack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerIds: [worker.id], creatureId: creature.id }),
    });
    expect(attackRes.status).toBe(200);

    // Stage 10 bugfix: fog of war means this colony's view of `creature` can
    // drop out transiently while it's still alive (e.g. it wanders beyond
    // every current vision source while the attacking worker is still
    // travelling toward its last-known position) — "missing from
    // state.creatures" is therefore no longer proof of death. Death and its
    // carcass are created atomically in one transaction (Stage 6), and the
    // carcass spawns right at the kill site, within the attacking worker's
    // own vision radius — so wait for the new carcass to appear instead,
    // which is unambiguous proof of death regardless of fog.
    const deadline = Date.now() + 45000;
    let state = await getState();
    let carcass = state.resourceNodes.find(
      (n: any) => n.kind === "item" && n.resourceType === "protein" && !existingItemIds.has(n.id),
    );
    while (!carcass && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      state = await getState();
      carcass = state.resourceNodes.find(
        (n: any) => n.kind === "item" && n.resourceType === "protein" && !existingItemIds.has(n.id),
      );
    }
    expect(carcass).toBeDefined();

    // The attacking worker went idle right at the kill site (Stage 6 §10) —
    // use it directly rather than the generic gatherProteinUntil helper,
    // which would pick whichever protein node is nearest to an idle worker
    // and might find an ordinary source node instead of this specific carcass.
    const killerId = worker.id;
    const gatherRes = await request("/api/command/gather", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerIds: [killerId], resourceId: carcass.id }),
    });
    expect(gatherRes.status).toBe(200);

    // Wait for this specific worker to finish its carry-and-deposit round
    // trip AND for protein to actually rise — checking only "not carrying"
    // would pass trivially on the very first poll (right after issuing the
    // command, before travel to the carcass has even begun), and checking
    // only "protein increased" could be satisfied early by another worker's
    // unrelated, already-in-flight deposit while the killer is still walking
    // home, leaving it falsely "busy" for whatever test runs next.
    const depositDeadline = Date.now() + 30000;
    let after = await getState();
    let killer = after.workers.find((w: any) => w.id === killerId);
    while (
      (after.colony.resources.protein <= baselineProtein || killer.carrying) &&
      Date.now() < depositDeadline
    ) {
      await new Promise((r) => setTimeout(r, 200));
      after = await getState();
      killer = after.workers.find((w: any) => w.id === killerId);
    }
    expect(killer.carrying).toBeNull();
    expect(after.colony.resources.protein).toBeGreaterThan(baselineProtein);
  },
  60000,
);

// Stage 7 §26: mirrors the aphid-combat test above, but a spider hits back —
// every currently idle worker piles onto the fight rather than just one, so
// the test itself doesn't flake on an occasional unlucky single-worker loss,
// and so it exercises the "multiple workers, spider damages back mid-fight"
// case the brief specifically calls out.
it(
  "killing a spider leaves a carcass that can be gathered and deposited, surviving exactly one attacker's worth of combat",
  async () => {
    // Stage 10: fog of war — scout until a spider is actually visible before
    // trying to fight one.
    const before = await discoverCreatures(request, await getState(), { needSpecies: "spider" });
    const spider = before.creatures.find((c: any) => c.species === "spider");
    expect(spider, "seed should always include at least one spider").toBeDefined();
    const baselineProtein = before.colony.resources.protein;
    const attackers = before.workers.filter((w: any) => !w.carrying);
    expect(attackers.length).toBeGreaterThan(0);
    const existingItemIds = new Set(
      before.resourceNodes.filter((n: any) => n.kind === "item").map((n: any) => n.id),
    );

    const attackRes = await request("/api/command/attack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerIds: attackers.map((w: any) => w.id), creatureId: spider.id }),
    });
    expect(attackRes.status).toBe(200);

    const deadline = Date.now() + 45000;
    let state = await getState();
    while (state.creatures.some((c: any) => c.id === spider.id) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      state = await getState();
    }
    expect(state.creatures.some((c: any) => c.id === spider.id)).toBe(false);

    // Exactly one new carcass — no duplication even with several attackers
    // potentially landing lethal-adjacent hits in the same tick.
    const newItemNodes = state.resourceNodes.filter((n: any) => n.kind === "item" && !existingItemIds.has(n.id));
    expect(newItemNodes).toHaveLength(1);
    const carcass = newItemNodes[0];
    expect(carcass.resourceType).toBe("protein");
    expect(carcass.amount).toBe(carcass.maxAmount);

    // No auto-harvest: gather it explicitly, same as any other resource
    // node. Prefer one of the surviving attackers (it's already standing at
    // the kill site, per Stage 6's attacker-idle-sweep) over an arbitrary
    // idle worker, which could be anywhere on the map.
    const survivingAttackerIds = new Set(attackers.map((w: any) => w.id));
    const gatherer =
      state.workers.find((w: any) => survivingAttackerIds.has(w.id) && !w.carrying) ??
      state.workers.find((w: any) => !w.carrying);
    expect(gatherer, "need at least one idle worker left alive to gather the carcass").toBeDefined();
    const gathererId = gatherer.id;
    const gatherRes = await request("/api/command/gather", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerIds: [gathererId], resourceId: carcass.id }),
    });
    expect(gatherRes.status).toBe(200);

    const depositDeadline = Date.now() + 30000;
    let after = await getState();
    let g = after.workers.find((w: any) => w.id === gathererId);
    while ((after.colony.resources.protein <= baselineProtein || g.carrying) && Date.now() < depositDeadline) {
      await new Promise((r) => setTimeout(r, 200));
      after = await getState();
      g = after.workers.find((w: any) => w.id === gathererId);
    }
    expect(g.carrying).toBeNull();
    expect(after.colony.resources.protein).toBeGreaterThan(baselineProtein);
  },
  120000,
);

// Stage 8 §39/§40/§41: abandonment, restart, and the direct regression test
// for the motivating production bug (a colony with zero workers and
// insufficient protein was permanently stuck with no in-game recovery
// path). This file's one persistent `request` session is deliberately
// consumed to destruction here, at the very end of the suite — every prior
// test in this file depends on that colony still being active, so these
// tests must run last and the colony they abandon is never used again
// afterward.
it("abandoning requires no worker or resource — it defeats the colony, destroys resources, and removes every worker", async () => {
  const before = await getState();
  expect(before.colony.status).toBe("active");

  const res = await request("/api/abandon", { method: "POST" });
  expect(res.status).toBe(200);
  const after = await res.json();

  expect(after.colony.status).toBe("defeated");
  expect(after.colony.defeatCause).toBe("abandoned");
  expect(after.workers).toHaveLength(0);
  for (const type of RESOURCE_TYPES) {
    expect(after.colony.resources[type]).toBe(0);
  }

  // The ruin persists in the shared colonies roster, not removed.
  const roster = after.colonies.find((c: any) => c.id === after.colony.id);
  expect(roster).toMatchObject({ status: "defeated" });
});

it("a second abandon attempt on an already-defeated colony is rejected, not re-run", async () => {
  // Runs immediately after the test above — this session's colony is
  // already defeated.
  const res = await request("/api/abandon", { method: "POST" });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toBe("colony already defeated");
});

it("every mutating command is rejected on a defeated colony, by lifecycle status rather than absence of workers", async () => {
  const state = await getState();
  expect(state.colony.status).toBe("defeated");
  expect(state.workers).toHaveLength(0);

  const moveRes = await request("/api/command/move", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workerIds: [1], x: 10, y: 10 }),
  });
  expect(moveRes.status).toBe(400);

  const gatherRes = await request("/api/command/gather", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workerIds: [1], resourceId: 1 }),
  });
  expect(gatherRes.status).toBe(400);

  const attackRes = await request("/api/command/attack", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workerIds: [1], creatureId: 1 }),
  });
  expect(attackRes.status).toBe(400);

  const reproduceRes = await request("/api/reproduce", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ caste: "worker" }),
  });
  expect(reproduceRes.status).toBe(400);
});

it("Start New Colony is rejected while the current colony is still active", async () => {
  // A fresh session, still fully active — eligibility is "defeated", not
  // resource balance, so an active colony must be rejected regardless of
  // its resource state.
  const activeSession = createSession();
  await activeSession("/api/state"); // mint the session's colony first
  const res = await activeSession("/api/start-new-colony", { method: "POST" });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toBe("colony still active");
});

it(
  "Start New Colony on a defeated session produces a fresh, full-health, standard-resource colony in the same session",
  async () => {
    const defeatedBefore = await getState();
    expect(defeatedBefore.colony.status).toBe("defeated");
    const oldColonyId = defeatedBefore.colony.id;

    const res = await request("/api/start-new-colony", { method: "POST" });
    expect(res.status).toBe(200);
    const after = await res.json();

    // New identity, not a resurrection of the old one.
    expect(after.colony.id).not.toBe(oldColonyId);
    expect(after.colony.status).toBe("active");
    expect(after.colony.defeatCause).toBeNull();
    expect(after.colony.queenHealth).toBe(after.colony.queenMaxHealth);

    // Standard Stage 6b starting state — immediately playable.
    expect(after.workers).toHaveLength(3);
    expect(after.colony.resources.protein).toBe(STARTING_PROTEIN);
    expect(after.colony.resources.sugar).toBe(0);
    expect(after.colony.resources.biomass).toBe(0);

    // Spawned somewhere in-bounds, not colliding with the old ruin.
    expect(after.colony.queenX).toBeGreaterThanOrEqual(0);
    expect(after.colony.queenX).toBeLessThanOrEqual(after.world.width);
    expect(after.colony.queenY).toBeGreaterThanOrEqual(0);
    expect(after.colony.queenY).toBeLessThanOrEqual(after.world.height);

    // The new colony's own roster entry is always present (own-ness, not
    // geometry, gates visibility of your own colony — Stage 10 fog of war).
    // The old ruin is never deleted (it remains in the database and in any
    // viewer whose vision actually covers it — see spec/fog.test.ts), but
    // Stage 8's spawn-avoidance deliberately steers a fresh colony away from
    // existing ruins, so the new colony's own vision has no particular
    // reason to currently cover the old ruin's position; this test no longer
    // assumes it's part of *this* viewer's fogged roster.
    const newRoster = after.colonies.find((c: any) => c.id === after.colony.id);
    expect(newRoster).toMatchObject({ status: "active" });

    // Same session, fetched again, sees the new colony directly — no need
    // to resubmit start-new-colony.
    const refetched = await getState();
    expect(refetched.colony.id).toBe(after.colony.id);

    // Immediately playable: a move command on the new colony's own worker
    // succeeds.
    const worker = after.workers[0];
    const moveRes = await request("/api/command/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerIds: [worker.id], x: worker.x, y: worker.y }),
    });
    expect(moveRes.status).toBe(200);
  },
);

// Stage 8 §41: the direct regression test for the real production bug this
// stage exists to fix — a colony with zero workers and less than
// REPRODUCE_COST protein had no in-game recovery path whatsoever before
// Abandon Colony existed. This drives a brand-new session's colony into
// exactly that state, confirms it's genuinely stuck, then confirms Abandon
// -> Start New Colony recovers it into an immediately playable colony.
it(
  "soft-lock regression: a colony with zero workers and insufficient protein cannot recover via gameplay, but Abandon -> Start New Colony fully recovers it",
  async () => {
    const stuckRequest = createSession();
    const seeded = await (await stuckRequest("/api/state")).json();
    // A fresh colony starts with exactly REPRODUCE_COST protein (Stage 6b) —
    // spend it on one extra worker first so the colony ends up genuinely
    // below REPRODUCE_COST, not merely at it, once every worker is dead.
    expect(seeded.colony.resources.protein).toBe(REPRODUCE_COST);
    const reproduceSeedRes = await stuckRequest("/api/reproduce", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ caste: "worker" }),
    });
    expect(reproduceSeedRes.status).toBe(200);

    // Kill every starting worker by walking it directly onto a nearby
    // spider's position, forcing aggro, and waiting for it to die. The
    // *nearest* spider, not merely the first one enumerated — spiders are
    // scattered across the whole map, and this colony's spawn point isn't
    // guaranteed to be close to whichever spider id happens to sort first,
    // which otherwise makes this test's travel time (and its 30s-per-worker
    // deadline) depend on spider-population layout rather than the thing
    // it's meant to test.
    // Stage 10: fog of war — a spider isn't guaranteed to already be in
    // view, and shrinking vision (fewer living workers each iteration) only
    // makes that worse. Scout once up front to learn a spider's position,
    // then keep reusing that last-known position to aim subsequent workers
    // even once it's no longer actually in view — walking a worker toward
    // where a spider recently was is enough to re-enter its aggro range and
    // trigger a fresh chase, without needing a full re-scout every time.
    let state = await discoverCreatures(stuckRequest, await (await stuckRequest("/api/state")).json(), {
      needSpecies: "spider",
    });
    let lastKnownSpider = state.creatures.find((c: any) => c.species === "spider");
    while (state.workers.length > 0) {
      const visibleSpider = state.creatures.find((c: any) => c.species === "spider");
      if (visibleSpider) lastKnownSpider = visibleSpider;
      if (!lastKnownSpider) {
        state = await discoverCreatures(stuckRequest, state, { needSpecies: "spider" });
        lastKnownSpider = state.creatures.find((c: any) => c.species === "spider");
      }
      expect(lastKnownSpider, "seed should always include at least one spider").toBeDefined();
      const worker = state.workers[0];
      const spiders = state.creatures.filter((c: any) => c.species === "spider");
      const spider =
        spiders.length > 0
          ? spiders.reduce((best: any, c: any) =>
              Math.hypot(c.x - worker.x, c.y - worker.y) < Math.hypot(best.x - worker.x, best.y - worker.y) ? c : best,
            )
          : lastKnownSpider;
      await stuckRequest("/api/command/move", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerIds: [worker.id], x: spider.x, y: spider.y }),
      });
      const deadline = Date.now() + 30000;
      while (state.workers.some((w: any) => w.id === worker.id) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 300));
        state = await (await stuckRequest("/api/state")).json();
      }
      // Stage 10: the spider's last-known position can go stale by the time
      // the worker arrives (it wanders on its own) — if the worker is still
      // alive when the deadline lapses, the aimed-at spot was probably
      // empty. Re-scout for a fresh spider position (and forget the stale
      // one) before the outer loop retries, instead of looping forever at
      // the same dead coordinates.
      if (state.workers.some((w: any) => w.id === worker.id)) {
        state = await discoverCreatures(stuckRequest, state, { needSpecies: "spider" });
        lastKnownSpider = state.creatures.find((c: any) => c.species === "spider");
      }
    }
    expect(state.workers).toHaveLength(0);
    expect(state.colony.resources.protein).toBeLessThan(REPRODUCE_COST);
    expect(state.colony.status).toBe("active"); // the queen herself is untouched

    // No in-game recovery: reproduce fails (insufficient protein), and there
    // are no workers left to gather more.
    const reproduceRes = await stuckRequest("/api/reproduce", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ caste: "worker" }),
    });
    expect(reproduceRes.status).toBe(400);

    // Abandon -> Start New Colony recovers it.
    const abandonRes = await stuckRequest("/api/abandon", { method: "POST" });
    expect(abandonRes.status).toBe(200);
    const abandoned = await abandonRes.json();
    expect(abandoned.colony.status).toBe("defeated");

    const restartRes = await stuckRequest("/api/start-new-colony", { method: "POST" });
    expect(restartRes.status).toBe(200);
    const restarted = await restartRes.json();
    expect(restarted.colony.status).toBe("active");
    expect(restarted.workers).toHaveLength(3);
    expect(restarted.colony.resources.protein).toBe(STARTING_PROTEIN);

    // And it's genuinely playable again.
    const worker = restarted.workers[0];
    const moveRes = await stuckRequest("/api/command/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerIds: [worker.id], x: worker.x, y: worker.y }),
    });
    expect(moveRes.status).toBe(200);
  },
  // Stage 10: fog of war adds an up-front scouting phase (up to
  // discoverCreatures' own 60s deadline) before the per-worker kill loop
  // (4 workers, up to 30s each) even begins.
  240000,
);
