import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");

// Stage 9: permanent, colony-lineage-scoped evolution. This file is the
// black-box HTTP counterpart to spec/simulation.test.ts's direct-call
// "Stage 9: evolution selection" tests — those already cover the full
// locked/unlocked/already-chosen/invalid-tier/invalid-choice/defeated
// rejection matrix and the exactly-once guarantee at the `simulation.ts`
// level. What's left to prove here, over real HTTP with real sessions, is
// the stuff only a black-box test can show: the request body can never
// forge authority over a colony that isn't the caller's own, a race between
// two real concurrent requests still resolves to exactly one winner, a
// selection is a shared-world fact another session sees without any special
// refresh step, and the whole lifecycle (ruin retains history, a
// replacement starts blank) holds end-to-end through real abandon/restart
// routes, not just via `applyEvolutionSelection` called directly.
//
// Not retested here: that a selection or a Survival I health conversion
// survives a process restart — that's already covered, more precisely, by
// spec/simulation.test.ts's direct `loadSimulation()` reload tests. There is
// no safe way to restart the actual dev/CI server mid-suite from a black-box
// test, and duplicating that assertion with a weaker proxy would add
// nothing.
//
// Per-test fresh createSession(), same convention as spec/multiplayer.test.ts
// — duplicated rather than imported, since that file is deliberately
// self-contained. These tests never depend on execution order or on what any
// other spec file already did to the shared world.
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

async function getState(request: ReturnType<typeof createSession>) {
  const res = await request("/api/state");
  expect(res.status).toBe(200);
  return res.json();
}

// Not imported from src/server/balance.ts, same black-box discipline as
// every other duplicated constant in this spec/ directory (see
// colony.test.ts's own comment on this).
const REPRODUCE_COST = 50;
const EVOLUTION_TIER_1_POPULATION = 5;
const BROOD_I_COST_MULTIPLIER = 0.8;

function closestNode(state: any, worker: any, resourceType: string) {
  const nodes = state.resourceNodes.filter((n: any) => n.resourceType === resourceType);
  if (nodes.length === 0) throw new Error(`seed has no ${resourceType} node`);
  return nodes.reduce((best: any, n: any) =>
    Math.hypot(n.x - worker.x, n.y - worker.y) < Math.hypot(best.x - worker.x, best.y - worker.y) ? n : best,
  );
}

// Stage 10: fog of war means a protein node isn't guaranteed to already be
// visible near a fresh colony's spawn — only every other spawn anchor gets
// one, and a colony claimed later in a shared world (as happens once an
// earlier spec file has already taken anchor 0) can land somewhere with no
// protein nearby at all. Sends every one of the colony's own workers on a
// grid search across the world until at least one protein node comes into
// view — same discovery pattern as spec/colony.test.ts's discoverCreatures,
// just for a resource type instead of a creature species.
async function discoverResourceType(
  request: ReturnType<typeof createSession>,
  state: any,
  resourceType: string,
  timeoutMs = 60000,
): Promise<any> {
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

  const hasType = (s: any) => s.resourceNodes.some((n: any) => n.resourceType === resourceType);

  const dispatch = async (s: any, wave: number) => {
    if (s.workers.length === 0) return;
    await Promise.all(
      s.workers.map((w: any, i: number) => {
        const point = waypoints[(wave * s.workers.length + i) % waypoints.length];
        return request("/api/command/move", {
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
  while (!hasType(current) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    current = await getState(request);
    if (!hasType(current) && Date.now() - lastDispatch > REDISPATCH_MS) {
      wave += 1;
      await dispatch(current, wave);
      lastDispatch = Date.now();
    }
  }
  return current;
}

// Stage 10: fog of war means Bob's own roster only lists a foreign colony
// (Alice's) once Bob's own vision actually covers that colony's queen
// position — no longer unconditional. Sends every one of Bob's own workers
// toward a known point (Alice's queen, told to us directly by Alice's own
// state response) and polls until that colony id shows up in Bob's roster.
async function scoutToward(
  request: ReturnType<typeof createSession>,
  state: any,
  x: number,
  y: number,
  targetColonyId: number,
  timeoutMs = 60000,
): Promise<any> {
  const seen = (s: any) => s.colonies.some((c: any) => c.id === targetColonyId);
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
  let current = state;
  if (seen(current)) return current;
  await dispatch(current);
  let lastDispatch = Date.now();
  const deadline = Date.now() + timeoutMs;
  while (!seen(current) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    current = await getState(request);
    if (!seen(current) && Date.now() - lastDispatch > REDISPATCH_MS) {
      await dispatch(current);
      lastDispatch = Date.now();
    }
  }
  return current;
}

// Same shape as colony.test.ts's gatherProteinUntil, parameterised by
// session since this file runs several independent sessions side by side.
// Stage 10: re-checks protein visibility on every cycle (not just once up
// front) and scouts for it whenever it's dropped out of view, since fog
// means a protein node already seen can later fall outside every worker's
// vision again before a later idle-worker round tries to re-target it.
async function gatherProteinUntil(request: ReturnType<typeof createSession>, targetProtein: number): Promise<any> {
  let state = await getState(request);
  const deadline = Date.now() + 90000;
  while (state.colony.resources.protein < targetProtein && Date.now() < deadline) {
    if (!state.resourceNodes.some((n: any) => n.resourceType === "protein")) {
      state = await discoverResourceType(request, state, "protein");
    }
    const idleWorkers = state.workers.filter((w: any) => !w.carrying);
    for (const worker of idleWorkers) {
      if (!state.resourceNodes.some((n: any) => n.resourceType === "protein")) break;
      const node = closestNode(state, worker, "protein");
      await request("/api/command/gather", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerIds: [worker.id], resourceId: node.id }),
      });
    }
    await new Promise((r) => setTimeout(r, 250));
    state = await getState(request);
  }
  if (state.colony.resources.protein < targetProtein) {
    throw new Error(`gatherProteinUntil(${targetProtein}) timed out at ${state.colony.resources.protein}`);
  }
  return state;
}

// Grows a fresh colony to a given peak population purely via ordinary
// gather-then-reproduce play (no debug/seed shortcut exists, nor should
// one) — reads the *effective* reproduceCost off state each cycle rather
// than a hardcoded 50, so this stays correct even once a Brood discount is
// already active.
async function growToPeakPopulation(request: ReturnType<typeof createSession>, target: number): Promise<any> {
  let state = await getState(request);
  while (state.colony.peakPopulation < target) {
    await gatherProteinUntil(request, state.colony.reproduceCosts.worker);
    const res = await request("/api/reproduce", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ caste: "worker" }),
    });
    expect(res.status).toBe(200);
    state = await res.json();
  }
  return state;
}

it("rejects every malformed or ineligible /api/evolve request with the exact documented error, and a defeated colony can never select", async () => {
  const alice = createSession();

  const missingFields = await alice("/api/evolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(missingFields.status).toBe(400);
  expect(await missingFields.json()).toEqual({ error: "tier and choice are required" });

  const wrongTypes = await alice("/api/evolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tier: "1", choice: "foraging" }),
  });
  expect(wrongTypes.status).toBe(400);
  expect(await wrongTypes.json()).toEqual({ error: "tier and choice are required" });

  for (const tier of [0, 4]) {
    const res = await alice("/api/evolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tier, choice: "foraging" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "invalid tier" });
  }

  const invalidChoice = await alice("/api/evolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tier: 1, choice: "soldier" }),
  });
  expect(invalidChoice.status).toBe(400);
  expect(await invalidChoice.json()).toEqual({ ok: false, error: "invalid choice" });

  // A fresh colony starts well below EVOLUTION_TIER_1_POPULATION (3 < 5) —
  // a structurally valid tier/choice is still locked.
  const before = await getState(alice);
  expect(before.colony.peakPopulation).toBeLessThan(EVOLUTION_TIER_1_POPULATION);
  const locked = await alice("/api/evolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tier: 1, choice: "foraging" }),
  });
  expect(locked.status).toBe(400);
  expect(await locked.json()).toEqual({ ok: false, error: "tier locked" });

  // Once defeated, every selection attempt is rejected the same way,
  // regardless of tier/choice validity.
  const abandonRes = await alice("/api/abandon", { method: "POST" });
  expect(abandonRes.status).toBe(200);
  const defeated = await alice("/api/evolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tier: 1, choice: "foraging" }),
  });
  expect(defeated.status).toBe(400);
  expect(await defeated.json()).toEqual({ ok: false, error: "colony defeated" });
});

it(
  "an eligible selection lands only on the caller's own colony even when the request body forges another colony's id, resolves exactly once under a concurrent double-POST race, is visible to another session's shared-world view with no reload, survives the colony's own defeat as permanent ruin history, and is absent from the fresh replacement that follows",
  async () => {
    const alice = createSession();
    const bob = createSession();

    const aliceGrown = await growToPeakPopulation(alice, EVOLUTION_TIER_1_POPULATION);
    expect(aliceGrown.colony.peakPopulation).toBe(EVOLUTION_TIER_1_POPULATION);
    expect(aliceGrown.colony.evolutionTier1).toBeNull();

    const bobBefore = await getState(bob);
    const aliceColonyId = aliceGrown.colony.id;
    const bobColonyId = bobBefore.colony.id;

    // Two real concurrent requests racing for the same still-unchosen tier,
    // one of them carrying a forged `colonyId` pointing at Bob's colony —
    // the server must resolve the acting colony exclusively from Alice's
    // session cookie, never from this field, and exactly one of the two
    // must win.
    const [resForaging, resSurvival] = await Promise.all([
      alice("/api/evolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tier: 1, choice: "foraging", colonyId: bobColonyId }),
      }),
      alice("/api/evolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tier: 1, choice: "survival" }),
      }),
    ]);
    const statuses = [resForaging.status, resSurvival.status].sort();
    expect(statuses).toEqual([200, 400]);

    const winningChoice = resForaging.status === 200 ? "foraging" : "survival";
    const loser = resForaging.status === 200 ? resSurvival : resForaging;
    expect(await loser.json()).toEqual({ ok: false, error: "tier already chosen" });

    const aliceAfter = await getState(alice);
    expect(aliceAfter.colony.evolutionTier1).toBe(winningChoice);

    // Bob's own colony is completely untouched by the forged id — proof the
    // field was never read as authority over which colony actually mutated.
    const bobAfter = await getState(bob);
    expect(bobAfter.colony.id).toBe(bobColonyId);
    expect(bobAfter.colony.evolutionTier1).toBeNull();
    expect(bobAfter.colony.peakPopulation).toBeLessThan(EVOLUTION_TIER_1_POPULATION);

    // Bob sees Alice's new evolution as a plain shared-world fact in his own
    // roster — no special refresh step, just the same `/api/state` any
    // client already polls, once Bob's own vision actually covers Alice's
    // queen (Stage 10 fog of war: a foreign colony is no longer a free,
    // unconditional roster entry).
    const bobScouted = await scoutToward(bob, bobAfter, aliceGrown.colony.queenX, aliceGrown.colony.queenY, aliceColonyId);
    const aliceFromBobRoster = bobScouted.colonies.find((c: any) => c.id === aliceColonyId);
    expect(aliceFromBobRoster).toMatchObject({
      status: "active",
      population: EVOLUTION_TIER_1_POPULATION,
      peakPopulation: EVOLUTION_TIER_1_POPULATION,
      evolutionTier1: winningChoice,
    });

    // Alice's colony is defeated (abandon stands in for a lethal spider hit,
    // same established pattern as spec/multiplayer.test.ts's lifecycle
    // test) — the evolution she chose, and the peak population that earned
    // it, become permanent ruin history: present forever, affecting nothing.
    const abandonRes = await alice("/api/abandon", { method: "POST" });
    expect(abandonRes.status).toBe(200);
    const aliceRuin = await abandonRes.json();
    expect(aliceRuin.colony.status).toBe("defeated");
    expect(aliceRuin.colony.evolutionTier1).toBe(winningChoice);
    expect(aliceRuin.colony.peakPopulation).toBe(EVOLUTION_TIER_1_POPULATION);

    const bobAfterRuin = await getState(bob);
    const ruinFromBob = bobAfterRuin.colonies.find((c: any) => c.id === aliceColonyId);
    expect(ruinFromBob).toMatchObject({
      status: "defeated",
      population: 0,
      peakPopulation: EVOLUTION_TIER_1_POPULATION,
      evolutionTier1: winningChoice,
      defeatCause: "abandoned",
    });

    // Starting over gives Alice a genuinely blank lineage: fresh peak
    // population, no inherited selections — and the old ruin stays exactly
    // as it was, visible to Bob alongside the new colony.
    const restartRes = await alice("/api/start-new-colony", { method: "POST" });
    expect(restartRes.status).toBe(200);
    const aliceFresh = await restartRes.json();
    expect(aliceFresh.colony.id).not.toBe(aliceColonyId);
    expect(aliceFresh.colony.status).toBe("active");
    expect(aliceFresh.colony.peakPopulation).toBeLessThan(EVOLUTION_TIER_1_POPULATION);
    expect(aliceFresh.colony.evolutionTier1).toBeNull();
    expect(aliceFresh.colony.evolutionTier2).toBeNull();
    expect(aliceFresh.colony.evolutionTier3).toBeNull();

    // The ruin's position never moves — it's the same point Bob was already
    // scouted toward above, so it's still covered by Bob's vision right now,
    // before redirecting his workers anywhere else.
    const bobStillAtRuin = await getState(bob);
    const oldRuinStillThere = bobStillAtRuin.colonies.find((c: any) => c.id === aliceColonyId);
    expect(oldRuinStillThere).toMatchObject({ status: "defeated", evolutionTier1: winningChoice });

    // Stage 10: fog of war — the replacement colony spawns at a different
    // point (deliberately steered away from the old ruin), so Bob's own
    // vision has no particular reason to already cover it; scout there
    // explicitly rather than assuming it's a free roster entry. This moves
    // Bob's workers away from the ruin, which is expected and fine — the
    // ruin's continued existence (never deleted) was already confirmed
    // above; a single viewer's vision can't cover two distant points at once
    // under fog, and nothing in this stage claims it should.
    const bobScoutedFresh = await scoutToward(
      bob,
      bobStillAtRuin,
      aliceFresh.colony.queenX,
      aliceFresh.colony.queenY,
      aliceFresh.colony.id,
    );
    const freshAliceFromBob = bobScoutedFresh.colonies.find((c: any) => c.id === aliceFresh.colony.id);
    expect(freshAliceFromBob).toMatchObject({ status: "active", evolutionTier1: null });
  },
  // Stage 10: fog of war adds up to two scouting phases (each up to 60s) on
  // top of growToPeakPopulation's own now-longer protein-discovery budget.
  240000,
);

it(
  "Brood's reproduction-cost discount is reflected in the caller's own effective reproduceCost immediately on selection, with no effect on any other colony",
  async () => {
    const alice = createSession();
    const bob = createSession();

    const aliceGrown = await growToPeakPopulation(alice, EVOLUTION_TIER_1_POPULATION);
    expect(aliceGrown.colony.reproduceCosts.worker).toBe(REPRODUCE_COST);

    const res = await alice("/api/evolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tier: 1, choice: "brood" }),
    });
    expect(res.status).toBe(200);
    const aliceAfter = await res.json();
    expect(aliceAfter.colony.evolutionTier1).toBe("brood");
    expect(aliceAfter.colony.reproduceCosts.worker).toBe(Math.round(REPRODUCE_COST * BROOD_I_COST_MULTIPLIER));

    // No further gameplay needed to observe it — the very next /api/state
    // already reflects it, and an unrelated colony's own cost is untouched.
    const aliceConfirm = await getState(alice);
    expect(aliceConfirm.colony.reproduceCosts.worker).toBe(Math.round(REPRODUCE_COST * BROOD_I_COST_MULTIPLIER));

    const bobState = await getState(bob);
    expect(bobState.colony.reproduceCosts.worker).toBe(REPRODUCE_COST);
  },
  // Stage 10: fog of war can require a protein-discovery detour inside
  // growToPeakPopulation's gatherProteinUntil (now up to 90s of its own
  // budget) before any reproduce cycle can proceed.
  120000,
);
