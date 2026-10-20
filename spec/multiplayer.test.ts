import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");

// Crit 10 ("Fly by instruments") requires the sim to become genuinely
// multi-user: two people, each in their own browser sharing no cookies or
// storage, act on the same world and the server tells them apart. The
// architectural call made for this stage is "one colony per player" — each
// session gets its own queen/workers/resources inside the one shared world,
// rather than several named operators sharing a single colony. See
// CLAUDE.md's Crit 10 section for the write-up this decision is pinned to.
//
// These tests assert the *contract* a session must satisfy, not how it's
// implemented, with one necessary exception: a black-box HTTP test can only
// simulate "two browser profiles that share no cookies or storage" by
// managing cookies itself, so this file assumes the session identity is
// carried in a cookie the server sets on first contact — the natural choice
// for something that must work with zero client-side JS or headers, exactly
// like the crit's own "separate Chrome profiles" test does. If the eventual
// implementation identifies a session a different way, these tests (and this
// comment) need updating together.
//
// Every test here starts red: there is no per-session colony, no server-side
// ownership check, and no queryable action log yet. That's expected — see
// reflections/crit-10.md and CLAUDE.md for the plan to turn them green.

function createSession() {
  let cookie: string | null = null;
  return async function request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (cookie) headers.set("cookie", cookie);
    const res = await fetch(new URL(path, baseUrl), { ...init, headers });
    const setCookie = (res.headers as any).getSetCookie?.() ?? [];
    for (const header of setCookie) {
      // Keep just "name=value", dropping Path/HttpOnly/etc. attributes, same
      // as a real cookie jar would store.
      cookie = cookie ? `${cookie}; ${header.split(";")[0]}` : header.split(";")[0];
    }
    return res;
  };
}

async function getState(request: ReturnType<typeof createSession>) {
  const res = await request("/api/state");
  expect(res.status).toBe(200);
  return res.json();
}

// Stage 10: fog of war means a fresh session's own vision doesn't necessarily
// cover anything in particular — not a shared resource node, not a creature,
// not another colony's queen. These two helpers are the same disperse-and-poll
// discovery idiom used in spec/colony.test.ts (discoverCreatures) and
// spec/evolution.test.ts (discoverResourceType/scoutToward), copied here
// rather than imported per this codebase's established self-contained-spec-
// file discipline.

async function dispatchGridSearch(
  request: ReturnType<typeof createSession>,
  state: any,
  wave: number,
): Promise<void> {
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

// Disperses a session's own workers across the world until `isFound` is true
// of its own state, re-dispatching every 7s if nothing turns up yet.
async function discoverUntil(
  request: ReturnType<typeof createSession>,
  state: any,
  isFound: (s: any) => boolean,
  timeoutMs = 60000,
): Promise<any> {
  if (isFound(state)) return state;
  const REDISPATCH_MS = 7000;
  let wave = 0;
  let current = state;
  await dispatchGridSearch(request, current, wave);
  let lastDispatch = Date.now();

  const deadline = Date.now() + timeoutMs;
  while (!isFound(current) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    current = await getState(request);
    if (!isFound(current) && Date.now() - lastDispatch > REDISPATCH_MS) {
      wave += 1;
      await dispatchGridSearch(request, current, wave);
      lastDispatch = Date.now();
    }
  }
  return current;
}

// Sends every one of a session's own workers toward a known point and polls
// until an arbitrary predicate is true of this session's own state —
// generalized version used when the thing being scouted toward isn't
// specifically another colony's roster entry (e.g. a spider's position).
async function scoutTowardPoint(
  request: ReturnType<typeof createSession>,
  state: any,
  x: number,
  y: number,
  isFound: (s: any) => boolean,
  timeoutMs = 60000,
): Promise<any> {
  if (isFound(state)) return state;
  const REDISPATCH_MS = 7000;
  const dispatch = (s: any) =>
    s.workers.length > 0
      ? Promise.all(
          s.workers.map((w: any) =>
            request("/api/command/move", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ workerIds: [w.id], x, y }),
            }),
          ),
        )
      : Promise.resolve();
  await dispatch(state);
  let current = state;
  let lastDispatch = Date.now();
  const deadline = Date.now() + timeoutMs;
  while (!isFound(current) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    current = await getState(request);
    if (!isFound(current) && Date.now() - lastDispatch >= REDISPATCH_MS) {
      await dispatch(current);
      lastDispatch = Date.now();
    }
  }
  return current;
}

// Sends every one of a session's own workers toward a known point (another
// colony's queen, told to us directly by that colony's own state response)
// and polls until that colony id shows up in this session's own roster.
async function scoutToward(
  request: ReturnType<typeof createSession>,
  state: any,
  x: number,
  y: number,
  targetColonyId: number,
  timeoutMs = 60000,
): Promise<any> {
  return scoutTowardPoint(request, state, x, y, (s: any) => s.colonies.some((c: any) => c.id === targetColonyId), timeoutMs);
}

it("gives two sessions that share no cookies their own distinct colony, stable across repeat requests", async () => {
  const alice = createSession();
  const bob = createSession();

  const aliceState1 = await getState(alice);
  const bobState = await getState(bob);
  const aliceState2 = await getState(alice);

  // Same session, asked twice, must land on the same colony both times.
  expect(aliceState1.colony.id).toBe(aliceState2.colony.id);

  // Two sessions that never shared a cookie must not land on the same colony.
  expect(aliceState1.colony.id).not.toBe(bobState.colony.id);

  // "One colony per player": each session's own workers belong only to it.
  expect(aliceState1.workers.length).toBeGreaterThan(0);
  expect(bobState.workers.length).toBeGreaterThan(0);
  const aliceWorkerIds = new Set(aliceState1.workers.map((w: any) => w.id));
  const bobWorkerIds = new Set(bobState.workers.map((w: any) => w.id));
  for (const id of aliceWorkerIds) expect(bobWorkerIds.has(id)).toBe(false);
});

it(
  "shows both sessions the same shared world, and each session the other's colony as part of that shared state",
  async () => {
  const alice = createSession();
  const bob = createSession();

  const aliceState = await getState(alice);
  const bobState = await getState(bob);

  // The world object itself (size etc.) is shared, not per-session — fog
  // only filters spatial entity *lists*, never this.
  expect(aliceState.world).toEqual(bobState.world);

  // Stage 10: fog of war means resourceNodes/creatures are no longer
  // guaranteed identical between two sessions — each only sees what's
  // within its own vision. What's still true of the shared world is that
  // every node/creature Alice can currently see really exists in it, which
  // we can confirm by checking Bob's view agrees on the subset he, after
  // scouting toward Alice's own position, can also see.
  const aliceVisibleResourceIds = new Set(aliceState.resourceNodes.map((n: any) => n.id));
  const aliceVisibleCreatureIds = new Set(aliceState.creatures.map((c: any) => c.id));

  // "The app tells them apart" has to be mutual and visible: each player's
  // presence is a fact of the shared world the other can see, not something
  // that quietly disappears once it's not "your" request. A bare list of
  // known colonies (id + queen position only — no resource ledger, which is
  // private to its owner) is the minimal shape that satisfies this — but
  // under fog, a foreign colony only appears once it's actually within the
  // viewer's own vision (Stage 10 §17/§50), so each direction needs its own
  // scouting step rather than an unconditional roster-contains check.
  expect(Array.isArray(aliceState.colonies)).toBe(true);
  const aliceColonyIds = aliceState.colonies.map((c: any) => c.id);
  expect(aliceColonyIds).toContain(aliceState.colony.id);

  const aliceScouted = await scoutToward(alice, aliceState, bobState.colony.queenX, bobState.colony.queenY, bobState.colony.id);
  expect(aliceScouted.colonies.map((c: any) => c.id)).toContain(bobState.colony.id);

  const bobScouted = await scoutToward(bob, bobState, aliceState.colony.queenX, aliceState.colony.queenY, aliceState.colony.id);
  expect(bobScouted.colonies.map((c: any) => c.id)).toContain(aliceState.colony.id);

  // Resource nodes a session can see are real, shared-world entities with
  // the same ids/positions no matter which colony's vision uncovered them
  // (resource nodes never move) — spot-check this by having Bob's state
  // (after scouting to wherever Alice is standing) agree on any ids both
  // now see.
  // Stage 10 bugfix: under full-suite conditions, other test files' colonies
  // are concurrently gathering from this same shared world, so a node's
  // `amount` can genuinely change between when aliceState was captured and
  // when bobScouted is (up to two 60s scouting phases later) — compare only
  // the fields that are truly immutable for a resource node (identity,
  // position, type, capacity), not the live, concurrently-mutated amount.
  for (const node of bobScouted.resourceNodes) {
    if (!aliceVisibleResourceIds.has(node.id)) continue;
    const aliceNode = aliceState.resourceNodes.find((n: any) => n.id === node.id);
    expect(aliceNode).toBeDefined();
    expect(aliceNode.kind).toEqual(node.kind);
    expect(aliceNode.resourceType).toEqual(node.resourceType);
    expect(aliceNode.x).toEqual(node.x);
    expect(aliceNode.y).toEqual(node.y);
    expect(aliceNode.maxAmount).toEqual(node.maxAmount);
  }
  // Creatures are the same shared-world entities too, but unlike resource
  // nodes they move continuously — scouting takes real wall-clock time, so
  // by the time Bob's state is fetched a creature both sides can see may no
  // longer be at the exact position aliceState captured minutes earlier.
  // Identity (id + species) is the invariant that survives the race, not
  // exact coordinates.
  for (const creature of bobScouted.creatures) {
    if (!aliceVisibleCreatureIds.has(creature.id)) continue;
    const aliceCreature = aliceState.creatures.find((c: any) => c.id === creature.id);
    expect(aliceCreature?.species).toEqual(creature.species);
  }
  },
  // Stage 10: fog of war adds up to two independent scouting phases (each up
  // to 60s) on top of the default per-test timeout.
  150000,
);

// Regression test for a real production bug found during manual Stage 6b
// testing: two colonies moved to the same spot could not see each other's
// workers, because getState() was filtering `workers` down to the caller's
// own colony. The fix adds a separate `otherWorkers` field (every worker NOT
// belonging to the caller, each tagged with its public colonyId) rather than
// widening `workers` itself, so "workers = my own colony, fully selectable"
// stays true and selection/hit-testing in the client needed no new filter.
it(
  "gives each session visibility into every other colony's workers, tagged with a public colonyId, without touching its own controllable set",
  async () => {
  const alice = createSession();
  const bob = createSession();

  const aliceState = await getState(alice);
  const bobState = await getState(bob);

  // Stage 10: fog of war means otherWorkers only lists a foreign colony's
  // workers once this session's own vision actually covers them. B & C below
  // assert *every* own worker is seen by the other side, which needs more
  // than scoutToward's "colony has become visible" — the first worker to
  // arrive near the other's queen makes the colony itself visible well
  // before every other worker has finished travelling there too. Command
  // every worker on both sides at the exact same target point (the other
  // colony's queen) and poll until each side's full own roster shows up in
  // the other's otherWorkers list, re-issuing the move periodically in case
  // separation among the converging group stalls a straggler.
  const aliceTarget = { x: bobState.colony.queenX, y: bobState.colony.queenY };
  const bobTarget = { x: aliceState.colony.queenX, y: aliceState.colony.queenY };
  const sendAll = async (request: ReturnType<typeof createSession>, workers: any[], target: { x: number; y: number }) => {
    await Promise.all(
      workers.map((w: any) =>
        request("/api/command/move", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workerIds: [w.id], ...target }),
        }),
      ),
    );
  };
  await sendAll(alice, aliceState.workers, aliceTarget);
  await sendAll(bob, bobState.workers, bobTarget);

  const aliceAllSeenByBob = (s: any) =>
    aliceState.workers.every((w: any) => s.otherWorkers.some((o: any) => o.id === w.id));
  const bobAllSeenByAlice = (s: any) =>
    bobState.workers.every((w: any) => s.otherWorkers.some((o: any) => o.id === w.id));

  const REDISPATCH_MS = 7000;
  let lastDispatch = Date.now();
  let aliceScouted = aliceState;
  let bobScouted = bobState;
  const deadline = Date.now() + 60000;
  while ((!aliceAllSeenByBob(bobScouted) || !bobAllSeenByAlice(aliceScouted)) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    aliceScouted = await getState(alice);
    bobScouted = await getState(bob);
    if ((!aliceAllSeenByBob(bobScouted) || !bobAllSeenByAlice(aliceScouted)) && Date.now() - lastDispatch > REDISPATCH_MS) {
      await sendAll(alice, aliceScouted.workers, aliceTarget);
      await sendAll(bob, bobScouted.workers, bobTarget);
      lastDispatch = Date.now();
    }
  }

  // D: otherWorkers carries enough public ownership info to tell colonies
  // apart — a colonyId, never a session identifier/cookie.
  expect(Array.isArray(aliceScouted.otherWorkers)).toBe(true);
  for (const w of aliceScouted.otherWorkers) {
    expect(typeof w.colonyId).toBe("number");
    expect(w).not.toHaveProperty("sid");
    expect(w).not.toHaveProperty("session");
    expect(w).not.toHaveProperty("cookie");
  }

  // B & C: each session's own workers show up in the *other* session's
  // otherWorkers list, once that other session's vision covers them — the
  // shared world contains both colonies' workers, readable from either side.
  const aliceOwnIds = new Set(aliceScouted.workers.map((w: any) => w.id));
  const bobOwnIds = new Set(bobScouted.workers.map((w: any) => w.id));
  const aliceSeenByBobIds = new Set(
    bobScouted.otherWorkers.filter((w: any) => w.colonyId === aliceState.colony.id).map((w: any) => w.id),
  );
  const bobSeenByAliceIds = new Set(
    aliceScouted.otherWorkers.filter((w: any) => w.colonyId === bobState.colony.id).map((w: any) => w.id),
  );
  expect(aliceSeenByBobIds).toEqual(aliceOwnIds);
  expect(bobSeenByAliceIds).toEqual(bobOwnIds);

  // Visibility must never leak into "controllable": each session's own
  // `workers` array — the only one hitTest/selectWorkersInBox consult on the
  // client — contains none of the other colony's workers, and otherWorkers
  // contains none of this session's own.
  for (const id of aliceOwnIds) expect(bobOwnIds.has(id)).toBe(false);
  expect(aliceScouted.workers.some((w: any) => aliceScouted.otherWorkers.some((o: any) => o.id === w.id))).toBe(
    false,
  );
  expect(bobScouted.otherWorkers.every((w: any) => w.colonyId !== bobScouted.colony.id)).toBe(true);
  },
  // Stage 10: fog of war means waiting for every worker on both sides to
  // converge near the other's queen, up to 60s of its own polling budget.
  90000,
);

// G: realtime visibility, checked over plain HTTP polling (the WebSocket
// delivery path — H — is covered separately in spec/realtime.test.ts).
it(
  "lets session B observe, via its own state, a worker move issued by session A",
  async () => {
  const alice = createSession();
  const bob = createSession();

  const aliceState = await getState(alice);
  const bobState = await getState(bob); // make sure Bob's colony exists before Alice acts

  const aliceWorker = aliceState.workers[0];
  const target = {
    x: aliceWorker.x > aliceState.world.width / 2 ? 0 : aliceState.world.width,
    y: aliceWorker.y > aliceState.world.height / 2 ? 0 : aliceState.world.height,
  };

  const res = await alice("/api/command/move", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workerIds: [aliceWorker.id], x: target.x, y: target.y }),
  });
  expect(res.status).toBe(200);

  // Stage 10: fog of war means Bob's own vision has no particular reason to
  // already cover wherever Alice's worker is headed. We know the exact
  // target coordinates (computed above), so scout Bob's own workers
  // straight there rather than a blind grid search — a blind search over a
  // 4x4 grid has no guarantee of ever landing within vision range of one
  // specific far corner point.
  const bobScouted = await scoutTowardPoint(
    bob,
    bobState,
    target.x,
    target.y,
    (s: any) => s.otherWorkers.some((w: any) => w.id === aliceWorker.id),
  );

  const seenFromBob = bobScouted.otherWorkers.find((w: any) => w.id === aliceWorker.id);
  expect(seenFromBob, "Bob's state should include Alice's worker in otherWorkers").toBeTruthy();
  expect(Math.hypot(seenFromBob.x - aliceWorker.x, seenFromBob.y - aliceWorker.y)).toBeGreaterThan(5);
  expect(seenFromBob.colonyId).toBe(aliceState.colony.id);
  },
  90000,
);

it("rejects a session's attempt to command a worker that belongs to someone else's colony", async () => {
  const alice = createSession();
  const bob = createSession();

  const aliceState = await getState(alice);
  const bobState = await getState(bob);
  const bobWorker = bobState.workers[0];
  const farFromBobWorker = {
    x: bobWorker.x > bobState.world.width / 2 ? 0 : bobState.world.width,
    y: bobWorker.y > bobState.world.height / 2 ? 0 : bobState.world.height,
  };

  // Alice tries to command Bob's worker through her own session.
  const res = await alice("/api/command/move", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workerIds: [bobWorker.id], x: farFromBobWorker.x, y: farFromBobWorker.y }),
  });
  // Every id in the batch belongs to someone else, so — per the existing
  // batch-command contract (CLAUDE.md, §2) — the whole request fails.
  expect(res.status).toBe(400);

  // And, behaviourally, Bob's worker must not actually have moved.
  await new Promise((r) => setTimeout(r, 500));
  const bobStateAfter = await getState(bob);
  const bobWorkerAfter = bobStateAfter.workers.find((w: any) => w.id === bobWorker.id);
  expect(Math.hypot(bobWorkerAfter.x - bobWorker.x, bobWorkerAfter.y - bobWorker.y)).toBeLessThan(5);

  // Sanity check this isn't just "move is broken": Alice can still command
  // her own workers in the same request shape.
  const aliceWorker = aliceState.workers[0];
  const resOwn = await alice("/api/command/move", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workerIds: [aliceWorker.id], x: farFromBobWorker.x, y: farFromBobWorker.y }),
  });
  expect(resOwn.status).toBe(200);
});

// Stage 7 §6: issueAttackCommand only ever resolves creatureId against the
// creatures Map, never the workers Map — so passing another colony's worker
// id as creatureId can only ever be "no such creature" or, in the unlikely
// event of a numeric id collision across the two independent tables (both
// start their own id sequence at 1), an unrelated real creature. Either way
// the actual no-PvP invariant is that Bob's worker itself is never affected
// — that's what this asserts, rather than a specific status code or error
// string, since which of those two outcomes occurs depends on id collision
// and isn't itself the thing worth pinning down.
it("rejects a session's attempt to attack a worker belonging to someone else's colony — a worker id can never resolve as an attack target", async () => {
  const alice = createSession();
  const bob = createSession();

  const aliceState = await getState(alice);
  const bobState = await getState(bob);
  const bobWorker = bobState.workers[0];
  const aliceWorker = aliceState.workers[0];

  await alice("/api/command/attack", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workerIds: [aliceWorker.id], creatureId: bobWorker.id }),
  });

  await new Promise((r) => setTimeout(r, 1500));
  const bobStateAfter = await getState(bob);
  const bobWorkerAfter = bobStateAfter.workers.find((w: any) => w.id === bobWorker.id);
  expect(bobWorkerAfter).toBeDefined();
  expect(bobWorkerAfter.health).toBe(bobWorker.health);
  expect(Math.hypot(bobWorkerAfter.x - bobWorker.x, bobWorkerAfter.y - bobWorker.y)).toBeLessThan(5);

  // bobWorker.id lives in a separate autoincrement sequence from `creatures`,
  // so it can — and in this suite's fixed run order, does — collide with a
  // real live creature's id. That makes aliceWorker's attack command above a
  // real, uncancelled chase/kill against whatever creature that id actually
  // names, which would otherwise keep running in the background for the rest
  // of the suite and could land a genuine kill (and an extra, unaccounted-for
  // carcass) in a later test. Overwrite aliceWorker's command before this
  // test ends so nothing it started outlives it — "last command wins" (Stage
  // 2) makes a plain move the simplest no-op-ish way to cancel an attack.
  await alice("/api/command/move", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workerIds: [aliceWorker.id], x: aliceWorker.x, y: aliceWorker.y }),
  });
});

// Stage 7 §27: creatures (and their carcasses) are global, neutral map
// content — any colony's workers can attack the same spider, so a kill is a
// race two colonies can both be part of. handleAttackCommand's existing
// "if (!creature) go idle, no-op" guard (Stage 6) is what prevents a double
// kill/duplicate carcass here; this proves that holds for two different
// colonies racing, not just two workers from the same one.
it(
  "two colonies attacking the same spider concurrently produce exactly one death and one carcass, visible identically to both",
  async () => {
    const alice = createSession();
    const bob = createSession();

    const aliceState = await getState(alice);
    const bobState = await getState(bob);

    // Stage 10: fog of war means a session's initial state has no particular
    // reason to already see a spider — disperse Alice's own workers to find
    // one first, same discoverUntil idiom used elsewhere in this file.
    const aliceWithSpider = await discoverUntil(alice, aliceState, (s: any) =>
      s.creatures.some((c: any) => c.species === "spider"),
    );
    const spider = aliceWithSpider.creatures.find((c: any) => c.species === "spider");
    expect(spider, "seed should always include at least one spider").toBeDefined();
    const existingItemIds = new Set(
      aliceWithSpider.resourceNodes.filter((n: any) => n.kind === "item").map((n: any) => n.id),
    );

    // Bob needs to see the same spider too before he can legally target it —
    // scout him toward Alice's now-known spider position. This can take real
    // wall-clock time, during which the spider may kill whichever worker
    // (Alice's or Bob's) is standing near it, going stale on us by the time
    // we're ready to attack — so re-fetch fresh state for each session right
    // before scouting it, never trusting a snapshot captured before the
    // other session's own scouting wall-clock time elapsed. Alice and Bob's
    // scouting are independent requests against independent sessions, so run
    // them concurrently rather than sequentially — this test's own outer
    // timeout budget doesn't have room for two separate up-to-60s scouting
    // legs back to back.
    const [aliceFresh, bobFresh] = await Promise.all([
      scoutTowardPoint(alice, await getState(alice), spider.x, spider.y, (s: any) =>
        s.creatures.some((c: any) => c.id === spider.id),
      ),
      scoutTowardPoint(bob, bobState, spider.x, spider.y, (s: any) => s.creatures.some((c: any) => c.id === spider.id)),
    ]);

    const aliceWorker = aliceFresh.workers.find((w: any) => !w.carrying) ?? aliceFresh.workers[0];
    const bobWorker = bobFresh.workers.find((w: any) => !w.carrying) ?? bobFresh.workers[0];

    // Stage 10: the two scoutTowardPoint calls above resolve independently —
    // whichever one finishes first then idles waiting on Promise.all for the
    // other, during which time the spider (which wanders continuously) can
    // drift back out of that session's vision before the attack is actually
    // issued, getting "target not visible" instead of a clean 200. Retry each
    // attack independently, re-scouting only the session whose attack was
    // rejected, rather than assuming one concurrent scout leg is sufficient.
    async function attackWithRetry(request: ReturnType<typeof createSession>, worker: any) {
      // Stage 10 bugfix: scoutTowardPoint sends every one of a colony's
      // workers toward the spider's own position to establish vision of it —
      // which means by the time it resolves, a worker (or, if the spider
      // went after the queen instead, the whole colony via defeatColony's
      // blanket worker wipe) may already have died in the approach, leaving
      // `.find() ?? [0]` with nothing and `worker` undefined here. The retry
      // loop below already re-fetches fresh state and picks a live worker
      // every attempt, so just defer the pick entirely when none was handed
      // in rather than crashing on `worker.id`.
      let currentWorkerId: number | null = worker ? worker.id : null;
      // Stage 10: the spider wanders continuously throughout this test —
      // re-scouting toward the position it was at when first discovered
      // (potentially a long time, under full-suite contention, before this
      // retry ever runs) can chase a point it vacated long ago. Track the
      // most recently observed live position instead and chase that.
      let targetX = spider.x;
      let targetY = spider.y;
      let lastRes: any = null;
      // Stage 10 bugfix: the original version attacked first and only
      // re-scouted AFTER a rejection. But the concurrent Promise.all above
      // means whichever session (alice/bob) finishes its scout first then
      // idles waiting for the other — during that idle time the spider (which
      // wanders continuously) can drift back out of vision, so the very FIRST
      // attack attempt can already be stale. Re-verify the target is actually
      // visible in this session's *current* state immediately before every
      // attempt, not only after a failure, and give this substantially more
      // attempts/time since this is the one place under full-suite contention
      // where the retry budget mattered most.
      for (let attempt = 0; attempt < 6; attempt++) {
        let current = await getState(request);
        if (!current.creatures.some((c: any) => c.id === spider.id)) {
          current = await scoutTowardPoint(
            request,
            current,
            targetX,
            targetY,
            (s: any) => s.creatures.some((c: any) => c.id === spider.id),
            20000,
          );
        }
        const liveSpider = current.creatures.find((c: any) => c.id === spider.id);
        if (liveSpider) {
          targetX = liveSpider.x;
          targetY = liveSpider.y;
        }
        const liveWorker = current.workers.find((w: any) => w.id === currentWorkerId) ?? current.workers[0];
        if (!liveWorker) {
          if (lastRes) return lastRes;
          continue;
        }
        currentWorkerId = liveWorker.id;
        const res = await request("/api/command/attack", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workerIds: [currentWorkerId], creatureId: spider.id }),
        });
        if (res.status === 200) return res;
        // Stage 10 bugfix: issueAttackCommand only ever returns "no such
        // creature" once `creatures.get(creatureId)` itself is empty — unlike
        // "target not visible", this isn't a fog symptom, it's unambiguous
        // proof the spider is genuinely dead (the other colony's hit landed
        // first). No amount of re-scouting/retrying will ever make this
        // attack land once that's true, so stop immediately and report the
        // race as resolved rather than burning the remaining retry budget on
        // a rejection that can never change.
        const body: any = await res.json().catch(() => null);
        if (currentWorkerId !== null && body?.errors?.[currentWorkerId] === "no such creature") {
          return { status: 200, racedAway: true } as any;
        }
        lastRes = res;
      }
      return lastRes;
    }

    const [resA, resB] = await Promise.all([attackWithRetry(alice, aliceWorker), attackWithRetry(bob, bobWorker)]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    // Stage 10: alice's own attacking worker may itself die in the fight
    // (spiders retaliate), taking her only nearby vision source with it
    // before the spider actually dies — so "the spider isn't in alice's
    // state anymore" can mean either "confirmed dead" or "merely fogged
    // out while still alive elsewhere." Don't trust that distinction from a
    // single poll: keep re-dispatching alice's remaining workers toward the
    // spider's last-known position, and treat the kill as confirmed only
    // once the resulting carcass itself is actually visible to her.
    const deadline = Date.now() + 45000;
    let state = await getState(alice);
    let newItemNodes = state.resourceNodes.filter((n: any) => n.kind === "item" && !existingItemIds.has(n.id));
    let lastRedispatch = Date.now();
    while (newItemNodes.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      state = await getState(alice);
      newItemNodes = state.resourceNodes.filter((n: any) => n.kind === "item" && !existingItemIds.has(n.id));
      if (newItemNodes.length === 0 && Date.now() - lastRedispatch > 5000 && state.workers.length > 0) {
        await Promise.all(
          state.workers.map((w: any) =>
            alice("/api/command/move", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ workerIds: [w.id], x: spider.x, y: spider.y }),
            }),
          ),
        );
        lastRedispatch = Date.now();
      }
    }
    expect(state.creatures.some((c: any) => c.id === spider.id)).toBe(false);
    expect(newItemNodes).toHaveLength(1);

    // Both colonies' views of the kill are identical — the carcass is
    // neutral/shared, not owned by whichever colony landed the final hit.
    // Bob's attacking worker may itself have died in the fight (spiders
    // retaliate), taking his only nearby vision source with it — re-scout
    // Bob's remaining workers toward the carcass's exact position (same as
    // the spider's death position) rather than trusting he still has
    // visibility there from before the kill.
    const carcass = newItemNodes[0];
    const bobStateAfter = await scoutTowardPoint(bob, await getState(bob), carcass.x, carcass.y, (s: any) =>
      s.resourceNodes.some((n: any) => n.id === carcass.id),
    );
    expect(bobStateAfter.creatures.some((c: any) => c.id === spider.id)).toBe(false);
    expect(bobStateAfter.resourceNodes.find((n: any) => n.id === carcass.id)).toEqual(carcass);
  },
  // Stage 10: several sequential up-to-60s legs (initial spider discovery,
  // concurrent alice/bob scouting, the attack retry's re-scouts, the
  // kill-confirmation poll with re-dispatch, bob's final scout to the
  // carcass) can genuinely sum well past 90s under full-suite DB
  // contention — give this generous room.
  270000,
);

it("logs who did what, server-side, in a form queryable over the API and attributable to the acting colony", async () => {
  const alice = createSession();
  const aliceState = await getState(alice);
  const aliceWorker = aliceState.workers[0];
  const destination = {
    x: aliceWorker.x > aliceState.world.width / 2 ? 0 : aliceState.world.width,
    y: aliceWorker.y > aliceState.world.height / 2 ? 0 : aliceState.world.height,
  };

  const moveRes = await alice("/api/command/move", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workerIds: [aliceWorker.id], x: destination.x, y: destination.y }),
  });
  expect(moveRes.status).toBe(200);

  const logRes = await alice("/api/log");
  expect(logRes.status).toBe(200);
  const log = await logRes.json();
  expect(Array.isArray(log)).toBe(true);

  const entry = log.find((e: any) => e.colonyId === aliceState.colony.id && String(e.action).includes("move"));
  expect(entry, `expected a log entry attributing a move to colony ${aliceState.colony.id}, got ${JSON.stringify(log)}`).toBeTruthy();

  // Durability within this run: the entry has to still be there a moment
  // later, not just in the response to the triggering request. (Surviving an
  // actual process restart isn't checkable from this black-box harness,
  // which runs one long-lived app instance for the whole suite — that part
  // is verified by hand, e.g. `flyctl logs`, same as the crit itself does.)
  await new Promise((r) => setTimeout(r, 200));
  const logResAgain = await alice("/api/log");
  const logAgain = await logResAgain.json();
  expect(logAgain.some((e: any) => e.colonyId === aliceState.colony.id && String(e.action).includes("move"))).toBe(
    true,
  );
});

// Stage 8 §42: the full two-session colony-defeat/restart lifecycle. Uses
// Alice's own Abandon Colony action to trigger defeat deterministically —
// per Stage 8's design, abandon() runs the exact same defeatColony()
// pipeline a lethal spider hit does (see spec/simulation.test.ts's
// "Stage 8: colony defeat" tests J/K for the direct proof those two paths
// share one implementation), so exercising it here is a faithful stand-in
// for "Alice's queen died" without the flakiness of waiting on real spider
// combat to land a kill in a black-box HTTP test.
it(
  "a colony's defeat and restart are visible to another session as a shared-world fact, without affecting that session's own colony or letting it control the defeated/restarted colony",
  async () => {
    const alice = createSession();
    const bob = createSession();

    const aliceBefore = await getState(alice);
    const bobBefore = await getState(bob);
    expect(aliceBefore.colony.status).toBe("active");
    expect(bobBefore.colony.status).toBe("active");

    // Every lifecycle route (abandon, start-new-colony) resolves strictly
    // from the caller's own session, never a body/query parameter — there is
    // structurally no colony id for Bob to even attempt to forge against
    // Alice's colony. What's left to verify is the shared-world behavior
    // once Alice abandons her own.

    // Stage 10: fog of war means Bob has no reason to already see Alice's
    // colony — scout him toward her queen's position first, before she
    // abandons, so his own vision already covers that spot once she does.
    const bobNearAlice = await scoutToward(
      bob,
      bobBefore,
      aliceBefore.colony.queenX,
      aliceBefore.colony.queenY,
      aliceBefore.colony.id,
    );

    // Alice abandons her own colony — the defeat-pipeline stand-in for a
    // natural queen death.
    const aliceAbandonRes = await alice("/api/abandon", { method: "POST" });
    expect(aliceAbandonRes.status).toBe(200);
    const aliceAbandoned = await aliceAbandonRes.json();
    expect(aliceAbandoned.colony.status).toBe("defeated");
    expect(aliceAbandoned.colony.defeatCause).toBe("abandoned");
    const oldAliceColonyId = aliceAbandoned.colony.id;

    // Bob's own session is wholly unaffected: still active, same colony,
    // own workers/resources untouched.
    const bobAfterAliceDefeat = await getState(bob);
    expect(bobAfterAliceDefeat.colony.id).toBe(bobBefore.colony.id);
    expect(bobAfterAliceDefeat.colony.status).toBe("active");
    expect(bobAfterAliceDefeat.workers.length).toBeGreaterThan(0);

    // Bob can see Alice's colony persist as a visible ruin in the shared
    // roster (his own workers are already stationed near her old queen
    // position from the scouting step above), and sees her workers gone
    // from the shared otherWorkers list — the shared world reflects the
    // defeat, it does not reset.
    const aliceRuinFromBob = bobAfterAliceDefeat.colonies.find((c: any) => c.id === oldAliceColonyId);
    expect(aliceRuinFromBob).toMatchObject({ status: "defeated" });
    expect(bobAfterAliceDefeat.otherWorkers.some((w: any) => w.colonyId === oldAliceColonyId)).toBe(false);

    // The rest of the shared world, from Bob's now-scouted vantage point, is
    // unchanged by Alice's defeat.
    expect(bobAfterAliceDefeat.resourceNodes.map((n: any) => n.id).sort()).toEqual(
      bobNearAlice.resourceNodes.map((n: any) => n.id).sort(),
    );
    expect(bobAfterAliceDefeat.creatures.map((c: any) => c.id).sort()).toEqual(
      bobNearAlice.creatures.map((c: any) => c.id).sort(),
    );

    // Bob cannot restart Alice's defeated colony through his own session —
    // his session's own colony is still active, so his own restart attempt
    // is rejected on his own behalf, never touching Alice's ruin.
    const bobRestartRes = await bob("/api/start-new-colony", { method: "POST" });
    expect(bobRestartRes.status).toBe(400);
    const bobAfterRestartAttempt = await getState(bob);
    expect(bobAfterRestartAttempt.colony.id).toBe(bobBefore.colony.id);
    expect(bobAfterRestartAttempt.colony.status).toBe("active");

    // Alice starts a new colony — visible live to Bob as a brand-new active
    // colony in the shared roster, while her old colony remains a ruin.
    const aliceRestartRes = await alice("/api/start-new-colony", { method: "POST" });
    expect(aliceRestartRes.status).toBe(200);
    const aliceRestarted = await aliceRestartRes.json();
    expect(aliceRestarted.colony.id).not.toBe(oldAliceColonyId);
    expect(aliceRestarted.colony.status).toBe("active");

    // Stage 10: the old ruin and Alice's new colony are two separate points
    // in the world — Bob's own vision can't necessarily cover both at the
    // same time. Check the ruin first, from where his workers already are
    // (unchanged since the scouting step above), then separately scout
    // toward Alice's new queen position — never try to check both from a
    // single post-scout state.
    const bobStillNearRuin = await getState(bob);
    const oldAliceRuinStillThere = bobStillNearRuin.colonies.find((c: any) => c.id === oldAliceColonyId);
    expect(oldAliceRuinStillThere).toMatchObject({ status: "defeated" });

    // Stage 10 bugfix: by the time this test runs, the full suite has already
    // minted many colonies across every other spec file sharing this one
    // running server/DB (CLAUDE.md's "repeated abandon/restart cycles push
    // new colonies further out on the same golden-angle spiral" tradeoff), so
    // Alice's new colony can legitimately land far from wherever Bob's
    // workers are currently stationed. Give this leg of the scout a longer
    // budget than the default — the earlier legs of this test are comparatively
    // cheap (no travel, or travel already completed), so the test's own
    // timeout has headroom to match.
    const bobNearNewAlice = await scoutToward(
      bob,
      bobStillNearRuin,
      aliceRestarted.colony.queenX,
      aliceRestarted.colony.queenY,
      aliceRestarted.colony.id,
      120000,
    );
    const newAliceColonyFromBob = bobNearNewAlice.colonies.find((c: any) => c.id === aliceRestarted.colony.id);
    expect(newAliceColonyFromBob).toMatchObject({ status: "active" });

    // Bob's own colony, resources, and workers are untouched throughout.
    expect(bobNearNewAlice.colony.id).toBe(bobBefore.colony.id);
    expect(bobNearNewAlice.colony.status).toBe("active");
  },
  210000,
);
