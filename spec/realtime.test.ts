import { expect, inject, it } from "vitest";
import { WebSocket } from "ws";

const baseUrl = inject("baseUrl");
const wsUrl = new URL("/ws", baseUrl);
wsUrl.protocol = wsUrl.protocol.replace("http", "ws");

// Crit 10: every HTTP call and every WebSocket connection in this file now
// belongs to the same one session/colony (one consistent browser profile),
// matching this file's pre-Crit-10 single-colony assumptions. The cookie
// jar itself mirrors spec/multiplayer.test.ts's createSession() (duplicated,
// not imported — that file is deliberately self-contained), but is kept at
// module scope here rather than per-session, since connect()'s WebSocket
// handshake also needs to read the latest cookie value directly — a WS
// upgrade bypasses Express entirely, so the handshake must carry the cookie
// header itself rather than relying on a browser's cookie jar. See
// CLAUDE.md's Crit 10 section.
let sessionCookie: string | null = null;

async function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (sessionCookie) headers.set("cookie", sessionCookie);
  const res = await fetch(new URL(path, baseUrl), { ...init, headers });
  const setCookie = (res.headers as any).getSetCookie?.() ?? [];
  for (const header of setCookie) {
    sessionCookie = sessionCookie ? `${sessionCookie}; ${header.split(";")[0]}` : header.split(";")[0];
  }
  return res;
}

async function getState() {
  const res = await request("/api/state");
  expect(res.status).toBe(200);
  return res.json();
}

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, sessionCookie ? { headers: { cookie: sessionCookie } } : undefined);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no message within ${timeoutMs}ms`)), timeoutMs);
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
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

// Waits on a sequence of broadcast frames until one shows the given resource
// above its baseline — a gather command only credits on arrival, so the
// immediate post-command frame(s) won't show it yet.
async function waitForResourceIncreaseOnSocket(
  ws: WebSocket,
  resourceType: string,
  baseline: number,
  timeoutMs = 15000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = await nextMessage(ws, Math.max(timeoutMs, 1));
    if (message.colony.resources[resourceType] > baseline) return message;
  }
  throw new Error(`no broadcast showed ${resourceType} above ${baseline} within ${timeoutMs}ms`);
}

// Regression test (H) for the post-Stage-6b multiplayer visibility bug: a
// worker move issued by one colony must reach another colony's own open
// WebSocket connection, in its `otherWorkers` field, with no reload. This
// needs a second, cookie-isolated colony — unlike every other test in this
// file, which reuses the single module-scope session — so it gets its own
// small self-contained cookie jar + WS connect helper, mirroring
// spec/multiplayer.test.ts's createSession() (duplicated, not imported, per
// this file's header comment on why these specs stay self-contained).
function createOtherSession() {
  let cookie: string | null = null;
  const sessionRequest = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set("cookie", cookie);
    const res = await fetch(new URL(path, baseUrl), { ...init, headers });
    const setCookie = (res.headers as any).getSetCookie?.() ?? [];
    for (const header of setCookie) {
      cookie = cookie ? `${cookie}; ${header.split(";")[0]}` : header.split(";")[0];
    }
    return res;
  };
  const sessionConnect = (): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, cookie ? { headers: { cookie } } : undefined);
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
  return { request: sessionRequest, connect: sessionConnect };
}

it("a worker move issued by one colony is delivered, as an otherWorkers update, to another colony's own open WebSocket connection with no reload", async () => {
  const colonyA = createOtherSession();
  const colonyB = createOtherSession();

  const aState = await colonyA.request("/api/state").then((r) => r.json());
  await colonyB.request("/api/state").then((r) => r.json()); // ensure colony B's session/colony exists first

  const aWorker = aState.workers[0];
  const target = { x: Math.min(aState.world.width - 10, aWorker.x + 500), y: aWorker.y };

  const wsB = await colonyB.connect();
  try {
    const res = await colonyA.request("/api/command/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerIds: [aWorker.id], x: target.x, y: target.y }),
    });
    expect(res.status).toBe(200);

    const deadline = Date.now() + 3000;
    let moved = false;
    while (!moved && Date.now() < deadline) {
      const message = await nextMessage(wsB, 3000);
      const current = message.otherWorkers.find((w: any) => w.id === aWorker.id);
      if (current && (current.x !== aWorker.x || current.y !== aWorker.y)) moved = true;
    }
    expect(moved).toBe(true);
  } finally {
    wsB.close();
  }
});

it(
  "pushes the updated resources to an open connection when a gather command completes, with no reload",
  async () => {
    const before = await getState();
    const worker = before.workers[0];
    const node = closestNode(before, worker, "sugar");

    const ws = await connect();
    try {
      const res = await request("/api/command/gather", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerIds: [worker.id], resourceId: node.id }),
      });
      expect(res.status).toBe(200);

      // Stage 9's gather channel (GATHER_DURATION, see evolution.ts) adds real
      // latency on top of travel time to a full claim->return->deposit round
      // trip, so this needs more headroom than the default 15000ms budget.
      const message = await waitForResourceIncreaseOnSocket(ws, "sugar", before.colony.resources.sugar, 30000);
      const after = await getState();
      expect(message.colony.resources.sugar).toBe(after.colony.resources.sugar);
    } finally {
      ws.close();
    }
  },
  60000,
);

it(
  "broadcasts to every open connection, not just the one that caused the change",
  async () => {
    const [wsA, wsB] = await Promise.all([connect(), connect()]);
    try {
      const before = await getState();
      const worker = before.workers[1];
      const node = closestNode(before, worker, "sugar");

      const res = await request("/api/command/gather", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerIds: [worker.id], resourceId: node.id }),
      });
      expect(res.status).toBe(200);

      const [msgA, msgB] = await Promise.all([
        waitForResourceIncreaseOnSocket(wsA, "sugar", before.colony.resources.sugar, 30000),
        waitForResourceIncreaseOnSocket(wsB, "sugar", before.colony.resources.sugar, 30000),
      ]);

      expect(msgA.colony.resources.sugar).toBe(msgB.colony.resources.sugar);
    } finally {
      wsA.close();
      wsB.close();
    }
  },
  60000,
);

it("worker movement is broadcast to open WebSocket clients without a reload", async () => {
  const before = await getState();
  const worker = before.workers[0];
  const target = { x: Math.min(before.world.width - 10, worker.x + 500), y: worker.y };

  const ws = await connect();
  try {
    const res = await request("/api/command/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerIds: [worker.id], x: target.x, y: target.y }),
    });
    expect(res.status).toBe(200);

    // Movement is continuous and server-driven, not something the client can
    // compute — wait for a broadcast frame showing the worker somewhere
    // other than where it started.
    const deadline = Date.now() + 3000;
    let moved = false;
    while (!moved && Date.now() < deadline) {
      const message = await nextMessage(ws, 3000);
      const current = message.workers.find((w: any) => w.id === worker.id);
      if (current && (current.x !== worker.x || current.y !== worker.y)) moved = true;
    }
    expect(moved).toBe(true);
  } finally {
    ws.close();
  }
});

it("a group move command broadcasts one frame reflecting every moved worker to every open connection", async () => {
  const before = await getState();
  const movers = before.workers.slice(0, 2);
  const target = { x: Math.min(before.world.width - 10, before.colony.queenX + 400), y: before.colony.queenY };

  const [wsA, wsB] = await Promise.all([connect(), connect()]);
  try {
    const res = await request("/api/command/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerIds: movers.map((w: any) => w.id), x: target.x, y: target.y }),
    });
    expect(res.status).toBe(200);

    async function waitForBothMoved(ws: WebSocket): Promise<any> {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const message = await nextMessage(ws, 3000);
        const stillMoved = movers.every((w: any) => {
          const current = message.workers.find((c: any) => c.id === w.id);
          return current && (current.x !== w.x || current.y !== w.y);
        });
        if (stillMoved) return message;
      }
      throw new Error("no broadcast frame showed both movers having moved");
    }

    const [msgA, msgB] = await Promise.all([waitForBothMoved(wsA), waitForBothMoved(wsB)]);
    for (const w of movers) {
      const a = msgA.workers.find((c: any) => c.id === w.id);
      const b = msgB.workers.find((c: any) => c.id === w.id);
      expect(a).toEqual(b);
    }
  } finally {
    wsA.close();
    wsB.close();
  }
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

it("two simultaneous reproduce calls racing for the same protein: exactly one succeeds", async () => {
  await gatherProteinUntil(50);
  const before = await getState();

  // Stage 10: the client now requests a caste on every reproduce call; the
  // server 400s a missing/invalid caste before it ever reaches the protein
  // race itself (src/server/index.ts's POST /api/reproduce handler).
  const [resA, resB] = await Promise.all([
    request("/api/reproduce", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ caste: "worker" }),
    }),
    request("/api/reproduce", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ caste: "worker" }),
    }),
  ]);

  expect([resA.status, resB.status].sort()).toEqual([200, 400]);

  const after = await getState();
  expect(after.workers).toHaveLength(before.workers.length + 1);
}, 60000);

it(
  "the full claim -> carrying -> return -> deposit lifecycle is visible over the wire to two open connections",
  async () => {
    const before = await getState();
    const worker = before.workers.find((w: any) => !w.carrying) ?? before.workers[0];
    const node = closestNode(before, worker, "sugar");
    const baselineSugar = before.colony.resources.sugar;

    const [wsA, wsB] = await Promise.all([connect(), connect()]);
    try {
      const res = await request("/api/command/gather", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerIds: [worker.id], resourceId: node.id }),
      });
      expect(res.status).toBe(200);

      // First: a broadcast frame shows the worker carrying a payload while
      // the colony's sugar bucket is still at baseline — claim precedes
      // credit, even over the wire. Stage 9's gather channel (GATHER_DURATION,
      // see evolution.ts) adds real latency on top of travel time, so each
      // phase's deadline has more headroom than it needed pre-Stage-9.
      async function waitForCarrying(ws: WebSocket): Promise<any> {
        const deadline = Date.now() + 25000;
        while (Date.now() < deadline) {
          const message = await nextMessage(ws, 25000);
          const current = message.workers.find((w: any) => w.id === worker.id);
          if (current?.carrying) return message;
        }
        throw new Error("no broadcast frame showed the worker carrying a payload");
      }
      const [carryingA, carryingB] = await Promise.all([waitForCarrying(wsA), waitForCarrying(wsB)]);
      expect(carryingA.colony.resources.sugar).toBe(baselineSugar);
      expect(carryingB.colony.resources.sugar).toBe(baselineSugar);

      // Then: a later frame shows the deposit — sugar credited, carrying
      // cleared back to null — on both open connections.
      async function waitForDeposit(ws: WebSocket): Promise<any> {
        const deadline = Date.now() + 25000;
        while (Date.now() < deadline) {
          const message = await nextMessage(ws, 25000);
          const current = message.workers.find((w: any) => w.id === worker.id);
          if (current && !current.carrying && message.colony.resources.sugar > baselineSugar) return message;
        }
        throw new Error("no broadcast frame showed the deposit completing");
      }
      const [depositA, depositB] = await Promise.all([waitForDeposit(wsA), waitForDeposit(wsB)]);
      expect(depositA.colony.resources.sugar).toBe(depositB.colony.resources.sugar);
    } finally {
      wsA.close();
      wsB.close();
    }
  },
  60000,
);

// Stage 5: I — aphid state rides the same broadcast channel as every other
// mutation, with no separate creature protocol.
it("I: creature state is broadcast identically to every open connection, matching GET /api/state", async () => {
  const state = await getState();
  expect(Array.isArray(state.creatures)).toBe(true);
  expect(state.creatures.length).toBeGreaterThanOrEqual(10);

  const [wsA, wsB] = await Promise.all([connect(), connect()]);
  try {
    const [msgA, msgB] = await Promise.all([nextMessage(wsA, 3000), nextMessage(wsB, 3000)]);
    expect(Array.isArray(msgA.creatures)).toBe(true);
    expect(msgA.creatures).toHaveLength(state.creatures.length);
    const sortById = (list: any[]) => list.slice().sort((a, b) => a.id - b.id);
    expect(sortById(msgA.creatures)).toEqual(sortById(msgB.creatures));
  } finally {
    wsA.close();
    wsB.close();
  }
});

// Stage 5: I — aphid wandering is nobody-issued movement; it must still reach
// an open connection without a reload, proving creature advancement marks
// simulation state dirty for the broadcast loop same as worker movement does.
it("I: aphid wandering is visible over an open WebSocket connection without a reload", async () => {
  const before = await getState();

  const ws = await connect();
  try {
    const deadline = Date.now() + 20000;
    let moved = false;
    while (!moved && Date.now() < deadline) {
      const message = await nextMessage(ws, 20000);
      moved = message.creatures.some((c: any) => {
        const start = before.creatures.find((b: any) => b.id === c.id);
        return start !== undefined && (c.x !== start.x || c.y !== start.y);
      });
    }
    expect(moved).toBe(true);
  } finally {
    ws.close();
  }
});

// Stage 6: N -- combat rides the same broadcast channel as everything else.
// Health dropping, death, and the resulting carcass all arrive identically
// on every open connection, with no separate combat protocol.
it(
  "N: an attack's health drop, the creature's death, and its carcass are broadcast identically to every open connection",
  async () => {
    const before = await getState();
    const worker = before.workers.find((w: any) => !w.carrying) ?? before.workers[0];
    const creature = before.creatures[0];
    // The creature wanders (and is chased) before it dies, so its death
    // position won't match where it started — identify the new carcass by
    // which item-node id is new, not by position.
    const existingItemIds = new Set(
      before.resourceNodes.filter((n: any) => n.kind === "item").map((n: any) => n.id),
    );

    const [wsA, wsB] = await Promise.all([connect(), connect()]);
    try {
      const res = await request("/api/command/attack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerIds: [worker.id], creatureId: creature.id }),
      });
      expect(res.status).toBe(200);

      async function waitForDamaged(ws: WebSocket): Promise<any> {
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          const message = await nextMessage(ws, 20000);
          const current = message.creatures.find((c: any) => c.id === creature.id);
          if (current && current.health < creature.maxHealth) return message;
          if (!current) return message; // died before we caught a damaged-but-alive frame
        }
        throw new Error("no broadcast frame showed the creature damaged or dead");
      }
      const [damagedA, damagedB] = await Promise.all([waitForDamaged(wsA), waitForDamaged(wsB)]);
      const liveA = damagedA.creatures.find((c: any) => c.id === creature.id);
      const liveB = damagedB.creatures.find((c: any) => c.id === creature.id);
      expect(liveA).toEqual(liveB);

      async function waitForDeathAndCarcass(ws: WebSocket): Promise<any> {
        const deadline = Date.now() + 40000;
        while (Date.now() < deadline) {
          const message = await nextMessage(ws, 40000);
          const stillAlive = message.creatures.some((c: any) => c.id === creature.id);
          const carcass = message.resourceNodes.find(
            (n: any) => n.kind === "item" && n.resourceType === "protein" && !existingItemIds.has(n.id),
          );
          if (!stillAlive && carcass) return { message, carcass };
        }
        throw new Error("no broadcast frame showed the creature dead with its carcass present");
      }
      const [deathA, deathB] = await Promise.all([waitForDeathAndCarcass(wsA), waitForDeathAndCarcass(wsB)]);
      expect(deathA.carcass).toEqual(deathB.carcass);
      expect(deathA.message.creatures.some((c: any) => c.id === creature.id)).toBe(false);
      expect(deathB.message.creatures.some((c: any) => c.id === creature.id)).toBe(false);
    } finally {
      wsA.close();
      wsB.close();
    }
  },
  60000,
);

it(
  "a worker injured or killed by a spider is visible, as an otherWorkers health/presence change, to another colony's own open WebSocket connection",
  async () => {
    const colonyA = createOtherSession();
    const colonyB = createOtherSession();

    const aState = await colonyA.request("/api/state").then((r) => r.json());
    await colonyB.request("/api/state").then((r) => r.json()); // ensure colony B's session/colony exists first

    const aWorker = aState.workers.find((w: any) => !w.carrying) ?? aState.workers[0];
    const spider = aState.creatures.find((c: any) => c.species === "spider");
    expect(spider, "seed should always include at least one spider").toBeDefined();

    const wsB = await colonyB.connect();
    try {
      // Walk colony A's worker right onto the spider's (last-known) position
      // to force aggro quickly and deterministically — SPIDER_WANDER_RADIUS
      // (150) is smaller than SPIDER_AGGRO_RANGE (200), so even a fully
      // drifted spider is still well within aggro range once the worker
      // arrives there.
      const res = await colonyA.request("/api/command/move", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerIds: [aWorker.id], x: spider.x, y: spider.y }),
      });
      expect(res.status).toBe(200);

      const deadline = Date.now() + 45000;
      let sawDamage = false;
      let sawDeath = false;
      while (!(sawDamage && sawDeath) && Date.now() < deadline) {
        const message = await nextMessage(wsB, 45000);
        const current = message.otherWorkers.find((w: any) => w.id === aWorker.id);
        if (current && typeof current.health === "number" && current.health < current.maxHealth) sawDamage = true;
        if (!current) sawDeath = true;
      }
      expect(sawDamage).toBe(true);
      expect(sawDeath).toBe(true);
    } finally {
      wsB.close();
    }
  },
  60000,
);

// Stage 8: a colony's defeat and its eventual restart must reach every open
// connection, not just its own, via the shared public `colonies` roster.
// Uses colony A's own Abandon Colony action as a deterministic stand-in for
// a natural queen death — see spec/multiplayer.test.ts's identical rationale
// (abandon() and a lethal spider hit share the exact same defeatColony()
// pipeline, per spec/simulation.test.ts's "Stage 8: colony defeat" J/K
// tests) — rather than waiting on real spider combat to kill a queen within
// a black-box test's time budget.
it(
  "another colony's defeat, resulting ruin, and eventual restart are all visible live, via the shared colonies roster, to a different open connection",
  async () => {
    const colonyA = createOtherSession();
    const colonyB = createOtherSession();

    const aState = await colonyA.request("/api/state").then((r) => r.json());
    const wsB = await colonyB.connect();
    try {
      async function waitForColonyStatus(ws: WebSocket, colonyId: number, status: string): Promise<any> {
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          const message = await nextMessage(ws, 20000);
          const roster = message.colonies.find((c: any) => c.id === colonyId);
          if (roster && roster.status === status) return message;
        }
        throw new Error(`no broadcast frame showed colony ${colonyId} with status ${status}`);
      }

      const abandonRes = await colonyA.request("/api/abandon", { method: "POST" });
      expect(abandonRes.status).toBe(200);

      const ruinMessage = await waitForColonyStatus(wsB, aState.colony.id, "defeated");
      expect(ruinMessage.colonies.find((c: any) => c.id === aState.colony.id)).toMatchObject({ status: "defeated" });
      // Alice's workers disappear from B's shared otherWorkers view too.
      expect(ruinMessage.otherWorkers.some((w: any) => w.colonyId === aState.colony.id)).toBe(false);

      const restartRes = await colonyA.request("/api/start-new-colony", { method: "POST" });
      expect(restartRes.status).toBe(200);
      const restarted = await restartRes.json();
      expect(restarted.colony.id).not.toBe(aState.colony.id);

      const newColonyMessage = await waitForColonyStatus(wsB, restarted.colony.id, "active");
      expect(newColonyMessage.colonies.find((c: any) => c.id === restarted.colony.id)).toMatchObject({
        status: "active",
      });
      // The old ruin is still present and still defeated, even after A's
      // restart.
      expect(newColonyMessage.colonies.find((c: any) => c.id === aState.colony.id)).toMatchObject({
        status: "defeated",
      });
    } finally {
      wsB.close();
    }
  },
  60000,
);

// Stage 8: this file's module-scope session/colony is shared by every test
// above — abandoning it here, last, is deliberate so no earlier test in this
// file is left operating on a defeated colony. Confirms the defeat itself
// (status, resources, and worker removal) and the restart that follows are
// each broadcast directly to the acting colony's own open connection, not
// just readable via GET /api/state.
it(
  "a colony's own defeat and subsequent restart are each broadcast directly to its own open WebSocket connection",
  async () => {
    const before = await getState();
    expect(before.colony.status).toBe("active");

    const ws = await connect();
    try {
      const abandonRes = await request("/api/abandon", { method: "POST" });
      expect(abandonRes.status).toBe(200);

      const defeatDeadline = Date.now() + 20000;
      let defeatMessage: any;
      while (Date.now() < defeatDeadline) {
        const message = await nextMessage(ws, 20000);
        if (message.colony.status === "defeated") {
          defeatMessage = message;
          break;
        }
      }
      expect(defeatMessage, "no broadcast frame showed the colony defeated").toBeDefined();
      expect(defeatMessage.colony.defeatCause).toBe("abandoned");
      expect(defeatMessage.workers).toHaveLength(0);
      for (const type of ["sugar", "protein", "biomass"]) {
        expect(defeatMessage.colony.resources[type]).toBe(0);
      }

      const restartRes = await request("/api/start-new-colony", { method: "POST" });
      expect(restartRes.status).toBe(200);
      const restarted = await restartRes.json();

      const restartDeadline = Date.now() + 20000;
      let restartMessage: any;
      while (Date.now() < restartDeadline) {
        const message = await nextMessage(ws, 20000);
        if (message.colony.id === restarted.colony.id && message.colony.status === "active") {
          restartMessage = message;
          break;
        }
      }
      expect(restartMessage, "no broadcast frame showed the restarted colony active").toBeDefined();
      expect(restartMessage.workers.length).toBeGreaterThan(0);
    } finally {
      ws.close();
    }
  },
  60000,
);

// Stage 11 (Step 9): proves the server-side half of a login/logout mid-
// connection transition — the WebSocket handler caches only `sessionId`
// (Stage 8's fix) and broadcastState() re-resolves colonyId fresh via
// getColonyForSession() every time it runs, including the immediate
// broadcastState() call each /api/auth/* route already makes on success. A
// connection that stays open the whole time, with no reconnect, must see
// the account's own colony the instant it logs in — not the guest colony
// its session started out pointing at. The client-only reconnect UX this
// motivated (closing/reopening the socket on every auth transition, for the
// sake of resetting in-memory UI state) is covered separately in main.ts/
// spec/world.test.ts; this test is strictly about the server never serving
// a stale colony over an already-open socket.
function uniqueUsername(label: string) {
  return `${label}_${Math.random().toString(36).slice(2, 10)}`;
}

it(
  "a login on an already-open WebSocket connection's session re-points the very next broadcast frame to the account's own colony, with no reconnect",
  async () => {
    // A separate session registers an account with no pre-existing guest
    // colony, so the account gets a freshly minted colony of its own
    // (distinct from any guest colony involved below).
    const owner = createOtherSession();
    const username = uniqueUsername("midconn");
    const password = "correcthorsebattery";
    const regRes = await owner.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    expect(regRes.status).toBe(200);
    const ownerState = await owner.request("/api/state").then((r) => r.json());
    const accountColonyId = ownerState.colony.id;

    // The viewer session is a plain guest with its own distinct colony, and
    // opens a WebSocket connection while still a guest.
    const viewer = createOtherSession();
    const viewerState = await viewer.request("/api/state").then((r) => r.json());
    const guestColonyId = viewerState.colony.id;
    expect(guestColonyId).not.toBe(accountColonyId);

    const ws = await viewer.connect();
    try {
      // Logging in re-points only this session's account_id, server-side,
      // without closing the socket or touching the cookie — exactly the
      // "re-pointed mid-connection" scenario the per-tick re-resolution
      // contract exists for.
      const loginRes = await viewer.request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      expect(loginRes.status).toBe(200);

      const deadline = Date.now() + 10000;
      let sawAccountColony = false;
      while (!sawAccountColony && Date.now() < deadline) {
        const message = await nextMessage(ws, 10000);
        if (message.colony.id === accountColonyId) sawAccountColony = true;
        // Never expect a frame to regress to showing the orphaned guest
        // colony as "current" — login must not merge or flip back to it.
        expect(message.colony.id).not.toBe(guestColonyId);
      }
      expect(sawAccountColony, "no broadcast frame on the open socket showed the account's own colony after login").toBe(
        true,
      );
    } finally {
      ws.close();
    }
  },
  20000,
);
