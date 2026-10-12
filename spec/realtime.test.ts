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

it("pushes the updated resources to an open connection when a gather command completes, with no reload", async () => {
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

    const message = await waitForResourceIncreaseOnSocket(ws, "sugar", before.colony.resources.sugar);
    const after = await getState();
    expect(message.colony.resources.sugar).toBe(after.colony.resources.sugar);
  } finally {
    ws.close();
  }
});

it("broadcasts to every open connection, not just the one that caused the change", async () => {
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
      waitForResourceIncreaseOnSocket(wsA, "sugar", before.colony.resources.sugar),
      waitForResourceIncreaseOnSocket(wsB, "sugar", before.colony.resources.sugar),
    ]);

    expect(msgA.colony.resources.sugar).toBe(msgB.colony.resources.sugar);
  } finally {
    wsA.close();
    wsB.close();
  }
});

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

it("two simultaneous reproduce calls racing for the same protein: exactly one succeeds", { timeout: 60000 }, async () => {
  await gatherProteinUntil(50);
  const before = await getState();

  const [resA, resB] = await Promise.all([
    request("/api/reproduce", { method: "POST" }),
    request("/api/reproduce", { method: "POST" }),
  ]);

  expect([resA.status, resB.status].sort()).toEqual([200, 400]);

  const after = await getState();
  expect(after.workers).toHaveLength(before.workers.length + 1);
});

it(
  "the full claim -> carrying -> return -> deposit lifecycle is visible over the wire to two open connections",
  { timeout: 30000 },
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
      // credit, even over the wire.
      async function waitForCarrying(ws: WebSocket): Promise<any> {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          const message = await nextMessage(ws, 15000);
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
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          const message = await nextMessage(ws, 15000);
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
  { timeout: 60000 },
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
);
