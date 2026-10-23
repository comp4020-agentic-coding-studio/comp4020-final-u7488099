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

it("shows both sessions the same shared world, and each session the other's colony as part of that shared state", async () => {
  const alice = createSession();
  const bob = createSession();

  const aliceState = await getState(alice);
  const bobState = await getState(bob);

  // The world and its resource nodes/creatures are shared, not per-session.
  expect(aliceState.world).toEqual(bobState.world);
  expect(aliceState.resourceNodes.map((n: any) => n.id).sort()).toEqual(
    bobState.resourceNodes.map((n: any) => n.id).sort(),
  );
  expect(aliceState.creatures.map((c: any) => c.id).sort()).toEqual(bobState.creatures.map((c: any) => c.id).sort());

  // "The app tells them apart" has to be mutual and visible: each player's
  // presence is a fact of the shared world the other can see, not something
  // that quietly disappears once it's not "your" request. A bare list of
  // known colonies (id + queen position only — no resource ledger, which is
  // private to its owner) is the minimal shape that satisfies this.
  expect(Array.isArray(aliceState.colonies)).toBe(true);
  const aliceColonyIds = aliceState.colonies.map((c: any) => c.id);
  const bobColonyIds = bobState.colonies.map((c: any) => c.id);
  expect(aliceColonyIds).toContain(aliceState.colony.id);
  expect(aliceColonyIds).toContain(bobState.colony.id);
  expect(bobColonyIds).toContain(aliceState.colony.id);
});

// Regression test for a real production bug found during manual Stage 6b
// testing: two colonies moved to the same spot could not see each other's
// workers, because getState() was filtering `workers` down to the caller's
// own colony. The fix adds a separate `otherWorkers` field (every worker NOT
// belonging to the caller, each tagged with its public colonyId) rather than
// widening `workers` itself, so "workers = my own colony, fully selectable"
// stays true and selection/hit-testing in the client needed no new filter.
it("gives each session visibility into every other colony's workers, tagged with a public colonyId, without touching its own controllable set", async () => {
  const alice = createSession();
  const bob = createSession();

  const aliceState = await getState(alice);
  const bobState = await getState(bob);

  // D: otherWorkers carries enough public ownership info to tell colonies
  // apart — a colonyId, never a session identifier/cookie.
  expect(Array.isArray(aliceState.otherWorkers)).toBe(true);
  for (const w of aliceState.otherWorkers) {
    expect(typeof w.colonyId).toBe("number");
    expect(w).not.toHaveProperty("sid");
    expect(w).not.toHaveProperty("session");
    expect(w).not.toHaveProperty("cookie");
  }

  // B & C: each session's own workers show up in the *other* session's
  // otherWorkers list — the shared world contains both colonies' workers,
  // readable from either side.
  const aliceOwnIds = new Set(aliceState.workers.map((w: any) => w.id));
  const bobOwnIds = new Set(bobState.workers.map((w: any) => w.id));
  const aliceSeenByBobIds = new Set(
    bobState.otherWorkers.filter((w: any) => w.colonyId === aliceState.colony.id).map((w: any) => w.id),
  );
  const bobSeenByAliceIds = new Set(
    aliceState.otherWorkers.filter((w: any) => w.colonyId === bobState.colony.id).map((w: any) => w.id),
  );
  expect(aliceSeenByBobIds).toEqual(aliceOwnIds);
  expect(bobSeenByAliceIds).toEqual(bobOwnIds);

  // Visibility must never leak into "controllable": each session's own
  // `workers` array — the only one hitTest/selectWorkersInBox consult on the
  // client — contains none of the other colony's workers, and otherWorkers
  // contains none of this session's own.
  for (const id of aliceOwnIds) expect(bobOwnIds.has(id)).toBe(false);
  expect(aliceState.workers.some((w: any) => aliceState.otherWorkers.some((o: any) => o.id === w.id))).toBe(false);
  expect(bobState.otherWorkers.every((w: any) => w.colonyId !== bobState.colony.id)).toBe(true);
});

// G: realtime visibility, checked over plain HTTP polling (the WebSocket
// delivery path — H — is covered separately in spec/realtime.test.ts).
it("lets session B observe, via its own state, a worker move issued by session A", async () => {
  const alice = createSession();
  const bob = createSession();

  const aliceState = await getState(alice);
  await getState(bob); // make sure Bob's colony exists before Alice acts

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

  await new Promise((r) => setTimeout(r, 500));
  const bobStateAfter = await getState(bob);
  const seenFromBob = bobStateAfter.otherWorkers.find((w: any) => w.id === aliceWorker.id);
  expect(seenFromBob, "Bob's state should include Alice's worker in otherWorkers").toBeTruthy();
  expect(Math.hypot(seenFromBob.x - aliceWorker.x, seenFromBob.y - aliceWorker.y)).toBeGreaterThan(5);
  expect(seenFromBob.colonyId).toBe(aliceState.colony.id);
});

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
    const spider = aliceState.creatures.find((c: any) => c.species === "spider");
    expect(spider, "seed should always include at least one spider").toBeDefined();
    const existingItemIds = new Set(
      aliceState.resourceNodes.filter((n: any) => n.kind === "item").map((n: any) => n.id),
    );

    const aliceWorker = aliceState.workers.find((w: any) => !w.carrying) ?? aliceState.workers[0];
    const bobWorker = bobState.workers.find((w: any) => !w.carrying) ?? bobState.workers[0];

    const [resA, resB] = await Promise.all([
      alice("/api/command/attack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerIds: [aliceWorker.id], creatureId: spider.id }),
      }),
      bob("/api/command/attack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerIds: [bobWorker.id], creatureId: spider.id }),
      }),
    ]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const deadline = Date.now() + 45000;
    let state = await getState(alice);
    while (state.creatures.some((c: any) => c.id === spider.id) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      state = await getState(alice);
    }
    expect(state.creatures.some((c: any) => c.id === spider.id)).toBe(false);

    const newItemNodes = state.resourceNodes.filter((n: any) => n.kind === "item" && !existingItemIds.has(n.id));
    expect(newItemNodes).toHaveLength(1);

    // Both colonies' views of the kill are identical — the carcass is
    // neutral/shared, not owned by whichever colony landed the final hit.
    const bobStateAfter = await getState(bob);
    expect(bobStateAfter.creatures.some((c: any) => c.id === spider.id)).toBe(false);
    expect(bobStateAfter.resourceNodes.find((n: any) => n.id === newItemNodes[0].id)).toEqual(newItemNodes[0]);
  },
  60000,
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
    // roster, and sees her workers gone from the shared otherWorkers list —
    // the shared world reflects the defeat, it does not reset.
    const aliceRuinFromBob = bobAfterAliceDefeat.colonies.find((c: any) => c.id === oldAliceColonyId);
    expect(aliceRuinFromBob).toMatchObject({ status: "defeated" });
    expect(bobAfterAliceDefeat.otherWorkers.some((w: any) => w.colonyId === oldAliceColonyId)).toBe(false);

    // The rest of the shared world (resource nodes, creatures) is unchanged
    // for Bob by Alice's defeat.
    expect(bobAfterAliceDefeat.resourceNodes.map((n: any) => n.id).sort()).toEqual(
      bobBefore.resourceNodes.map((n: any) => n.id).sort(),
    );
    expect(bobAfterAliceDefeat.creatures.map((c: any) => c.id).sort()).toEqual(
      bobBefore.creatures.map((c: any) => c.id).sort(),
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

    const bobAfterAliceRestart = await getState(bob);
    const newAliceColonyFromBob = bobAfterAliceRestart.colonies.find((c: any) => c.id === aliceRestarted.colony.id);
    expect(newAliceColonyFromBob).toMatchObject({ status: "active" });
    const oldAliceRuinStillThere = bobAfterAliceRestart.colonies.find((c: any) => c.id === oldAliceColonyId);
    expect(oldAliceRuinStillThere).toMatchObject({ status: "defeated" });

    // Bob's own colony, resources, and workers are untouched throughout.
    expect(bobAfterAliceRestart.colony.id).toBe(bobBefore.colony.id);
    expect(bobAfterAliceRestart.colony.status).toBe("active");
  },
);
