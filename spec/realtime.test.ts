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

it("pushes the updated state to an open connection when gather happens, with no reload", async () => {
  const before = await getState();
  const worker = before.workers[0];
  const node = before.resourceNodes[0];

  const ws = await connect();
  try {
    const pushed = nextMessage(ws);
    const res = await fetch(new URL("/api/gather", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerId: worker.id, nodeId: node.id }),
    });
    expect(res.status).toBe(200);
    const mutated = await res.json();

    const message = await pushed;
    expect(message.colony.protein).toBe(mutated.colony.protein);
  } finally {
    ws.close();
  }
});

it("broadcasts to every open connection, not just the one that caused the change", async () => {
  const [wsA, wsB] = await Promise.all([connect(), connect()]);
  try {
    const before = await getState();
    const worker = before.workers[0];
    const node = before.resourceNodes[0];

    const [msgA, msgB, res] = await Promise.all([
      nextMessage(wsA),
      nextMessage(wsB),
      fetch(new URL("/api/gather", baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerId: worker.id, nodeId: node.id }),
      }),
    ]);
    const mutated = await res.json();

    expect(msgA.colony.protein).toBe(mutated.colony.protein);
    expect(msgB.colony.protein).toBe(mutated.colony.protein);
  } finally {
    wsA.close();
    wsB.close();
  }
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

it("two simultaneous reproduce calls racing for the same protein: exactly one succeeds", async () => {
  await gatherUntil(50);
  const before = await getState();

  const [resA, resB] = await Promise.all([
    fetch(new URL("/api/reproduce", baseUrl), { method: "POST" }),
    fetch(new URL("/api/reproduce", baseUrl), { method: "POST" }),
  ]);

  expect([resA.status, resB.status].sort()).toEqual([200, 400]);

  const after = await getState();
  expect(after.workers).toHaveLength(before.workers.length + 1);
});
