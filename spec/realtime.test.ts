import { expect, inject, it } from "vitest";
import { WebSocket } from "ws";

const baseUrl = inject("baseUrl");
const wsUrl = new URL("/ws", baseUrl);
wsUrl.protocol = wsUrl.protocol.replace("http", "ws");

async function getState() {
  const res = await fetch(new URL("/api/state", baseUrl));
  expect(res.status).toBe(200);
  return res.json();
}

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
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
    const res = await fetch(new URL("/api/command/gather", baseUrl), {
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

    const res = await fetch(new URL("/api/command/gather", baseUrl), {
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
    const res = await fetch(new URL("/api/command/move", baseUrl), {
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
    const res = await fetch(new URL("/api/command/move", baseUrl), {
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

it("two simultaneous reproduce calls racing for the same protein: exactly one succeeds", { timeout: 60000 }, async () => {
  await gatherProteinUntil(50);
  const before = await getState();

  const [resA, resB] = await Promise.all([
    fetch(new URL("/api/reproduce", baseUrl), { method: "POST" }),
    fetch(new URL("/api/reproduce", baseUrl), { method: "POST" }),
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
      const res = await fetch(new URL("/api/command/gather", baseUrl), {
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
