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

// Same shape as colony.test.ts's gatherProteinUntil, parameterised by
// session since this file runs several independent sessions side by side.
async function gatherProteinUntil(request: ReturnType<typeof createSession>, targetProtein: number): Promise<any> {
  let state = await getState(request);
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
    await gatherProteinUntil(request, state.colony.reproduceCost);
    const res = await request("/api/reproduce", { method: "POST" });
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
    // client already polls.
    const aliceFromBobRoster = bobAfter.colonies.find((c: any) => c.id === aliceColonyId);
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

    const bobFinal = await getState(bob);
    const freshAliceFromBob = bobFinal.colonies.find((c: any) => c.id === aliceFresh.colony.id);
    expect(freshAliceFromBob).toMatchObject({ status: "active", evolutionTier1: null });
    const oldRuinStillThere = bobFinal.colonies.find((c: any) => c.id === aliceColonyId);
    expect(oldRuinStillThere).toMatchObject({ status: "defeated", evolutionTier1: winningChoice });
  },
  90000,
);

it(
  "Brood's reproduction-cost discount is reflected in the caller's own effective reproduceCost immediately on selection, with no effect on any other colony",
  async () => {
    const alice = createSession();
    const bob = createSession();

    const aliceGrown = await growToPeakPopulation(alice, EVOLUTION_TIER_1_POPULATION);
    expect(aliceGrown.colony.reproduceCost).toBe(REPRODUCE_COST);

    const res = await alice("/api/evolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tier: 1, choice: "brood" }),
    });
    expect(res.status).toBe(200);
    const aliceAfter = await res.json();
    expect(aliceAfter.colony.evolutionTier1).toBe("brood");
    expect(aliceAfter.colony.reproduceCost).toBe(Math.round(REPRODUCE_COST * BROOD_I_COST_MULTIPLIER));

    // No further gameplay needed to observe it — the very next /api/state
    // already reflects it, and an unrelated colony's own cost is untouched.
    const aliceConfirm = await getState(alice);
    expect(aliceConfirm.colony.reproduceCost).toBe(Math.round(REPRODUCE_COST * BROOD_I_COST_MULTIPLIER));

    const bobState = await getState(bob);
    expect(bobState.colony.reproduceCost).toBe(REPRODUCE_COST);
  },
  60000,
);
