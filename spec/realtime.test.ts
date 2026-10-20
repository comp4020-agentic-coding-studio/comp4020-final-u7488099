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

// Stage 10: fog of war means GET /api/state and every broadcast now only
// include entities within the caller's own vision radius. Every helper below
// is duplicated (not imported) from the identical idiom already established
// in spec/colony.test.ts/evolution.test.ts/multiplayer.test.ts, per this
// file's own header comment on why these specs stay self-contained. `req` is
// whatever request function a given session uses — either this file's
// module-scope `request`, or a createOtherSession()'s own `.request`.
type Requester = (path: string, init?: RequestInit) => Promise<Response>;

async function getStateWith(req: Requester): Promise<any> {
  const res = await req("/api/state");
  expect(res.status).toBe(200);
  return res.json();
}

// Stage 10: never dispatch every worker on a search. Earlier versions sent
// the whole roster out on blind, whole-map searches that could take up to
// 60s per wave, re-run many times across this file's ~13 sequential tests
// against the one module-scope colony — leaving the queen completely
// unguarded for most of the file's multi-minute runtime, long enough for a
// roaming spider to find and kill every worker (and sometimes the queen)
// well before a later test ever runs. Holding the lowest-id worker back at
// its own current position keeps `workers[]` from ever going empty and
// keeps at least one worker inside the nest's spider-aggro exclusion zone.
// Search waypoints are also expanding rings around the colony's own queen
// instead of fixed whole-map quadrants, so searchers start close to home
// and only range farther out on later waves.
function splitHomeGuard(workers: any[]): { guard: any | null; searchers: any[] } {
  if (workers.length <= 1) return { guard: null, searchers: workers };
  const sorted = [...workers].sort((a, b) => a.id - b.id);
  return { guard: sorted[0], searchers: sorted.slice(1) };
}

// Recalls the home-guard worker to the queen's own position, not wherever it
// currently stands — an earlier wave may have sent it away before it became
// the guard, and only a position actually at the nest sits inside the
// spider-aggro exclusion zone (see isClearOfNests in simulation.ts).
function recallToQueen(req: Requester, worker: any, state: any) {
  return req("/api/command/move", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workerIds: [worker.id], x: state.colony.queenX, y: state.colony.queenY }),
  });
}

async function dispatchGridSearch(req: Requester, state: any, wave: number): Promise<void> {
  if (state.workers.length === 0) return;
  const { width, height } = state.world;
  const { queenX: qx, queenY: qy } = state.colony;
  const { guard, searchers } = splitHomeGuard(state.workers);

  const tasks: Promise<any>[] = [];
  if (guard) tasks.push(recallToQueen(req, guard, state));

  const RING_STEP = 450;
  const baseRadius = 350 + wave * RING_STEP;
  const count = Math.max(searchers.length, 1);
  searchers.forEach((w: any, i: number) => {
    const angle = (i / count) * Math.PI * 2 + wave * 0.9;
    const x = Math.min(Math.max(Math.round(qx + baseRadius * Math.cos(angle)), 10), width - 10);
    const y = Math.min(Math.max(Math.round(qy + baseRadius * Math.sin(angle)), 10), height - 10);
    tasks.push(
      req("/api/command/move", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerIds: [w.id], x, y }),
      }),
    );
  });
  await Promise.all(tasks);
}

// Keeps re-dispatching a widening grid search until `isFound` is true —
// used when we don't yet know roughly where the thing we need is.
async function discoverUntil(
  req: Requester,
  state: any,
  isFound: (s: any) => boolean,
  timeoutMs = 60000,
): Promise<any> {
  if (isFound(state)) return state;
  const REDISPATCH_MS = 7000;
  let wave = 0;
  let current = state;
  await dispatchGridSearch(req, current, wave);
  let lastDispatch = Date.now();

  const deadline = Date.now() + timeoutMs;
  while (!isFound(current) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    current = await getStateWith(req);
    if (!isFound(current) && Date.now() - lastDispatch > REDISPATCH_MS) {
      wave += 1;
      await dispatchGridSearch(req, current, wave);
      lastDispatch = Date.now();
    }
  }
  return current;
}

// Sends every worker straight at one known point — used once we already
// know where the thing we need visibility of is (e.g. another colony's
// queen), rather than searching blind.
async function scoutTowardPoint(
  req: Requester,
  state: any,
  x: number,
  y: number,
  isFound: (s: any) => boolean,
  timeoutMs = 60000,
): Promise<any> {
  if (isFound(state)) return state;
  const REDISPATCH_MS = 7000;
  const dispatch = (s: any) => {
    if (s.workers.length === 0) return Promise.resolve();
    const { guard, searchers } = splitHomeGuard(s.workers);
    const tasks: Promise<any>[] = [];
    if (guard) tasks.push(recallToQueen(req, guard, s));
    for (const w of searchers) {
      tasks.push(
        req("/api/command/move", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workerIds: [w.id], x, y }),
        }),
      );
    }
    return Promise.all(tasks);
  };
  await dispatch(state);
  let current = state;
  let lastDispatch = Date.now();
  const deadline = Date.now() + timeoutMs;
  while (!isFound(current) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    current = await getStateWith(req);
    if (!isFound(current) && Date.now() - lastDispatch > REDISPATCH_MS) {
      await dispatch(current);
      lastDispatch = Date.now();
    }
  }
  return current;
}

async function scoutToward(
  req: Requester,
  state: any,
  x: number,
  y: number,
  targetColonyId: number,
  timeoutMs = 60000,
): Promise<any> {
  return scoutTowardPoint(
    req,
    state,
    x,
    y,
    (s: any) => s.colonies.some((c: any) => c.id === targetColonyId),
    timeoutMs,
  );
}

async function discoverResourceType(
  req: Requester,
  state: any,
  resourceType: string,
  timeoutMs = 60000,
): Promise<any> {
  return discoverUntil(
    req,
    state,
    (s: any) => s.resourceNodes.some((n: any) => n.resourceType === resourceType),
    timeoutMs,
  );
}

async function discoverCreatures(
  req: Requester,
  state: any,
  opts: { minCount?: number; needSpecies?: string; timeoutMs?: number } = {},
): Promise<any> {
  const { minCount = 1, needSpecies, timeoutMs = 60000 } = opts;
  return discoverUntil(
    req,
    state,
    (s: any) =>
      s.creatures.length >= minCount && (!needSpecies || s.creatures.some((c: any) => c.species === needSpecies)),
    timeoutMs,
  );
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

it(
  "a worker move issued by one colony is delivered, as an otherWorkers update, to another colony's own open WebSocket connection with no reload",
  async () => {
    const colonyA = createOtherSession();
    const colonyB = createOtherSession();

    const aState = await colonyA.request("/api/state").then((r) => r.json());
    let bState = await colonyB.request("/api/state").then((r) => r.json());

    const aWorker = aState.workers[0];
    const target = { x: Math.min(aState.world.width - 10, aWorker.x + 500), y: aWorker.y };

    // Stage 10: colony B must have vision of colony A's worker before it can
    // ever appear in B's own otherWorkers payload at all. This scouting leg
    // alone can take up to its own 60s budget — the outer it() timeout below
    // must leave room for it plus the actual move+broadcast check that
    // follows, not just match scoutTowardPoint's own internal deadline.
    bState = await scoutTowardPoint(colonyB.request, bState, aWorker.x, aWorker.y, (s: any) =>
      s.otherWorkers.some((w: any) => w.id === aWorker.id),
    );
    expect(
      bState.otherWorkers.some((w: any) => w.id === aWorker.id),
      "colony B never gained vision of colony A's worker",
    ).toBe(true);

    const wsB = await colonyB.connect();
    try {
      const res = await colonyA.request("/api/command/move", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerIds: [aWorker.id], x: target.x, y: target.y }),
      });
      expect(res.status).toBe(200);

      const deadline = Date.now() + 10000;
      let moved = false;
      while (!moved && Date.now() < deadline) {
        const message = await nextMessage(wsB, 10000);
        const current = message.otherWorkers.find((w: any) => w.id === aWorker.id);
        if (current && (current.x !== aWorker.x || current.y !== aWorker.y)) moved = true;
      }
      expect(moved).toBe(true);
    } finally {
      wsB.close();
    }
  },
  // Stage 10: scoutTowardPoint's own internal deadline is up to 60s on top
  // of the move+broadcast check's own 10s deadline — give this generous
  // room rather than let the scouting leg alone exhaust the outer timeout.
  90000,
);

it(
  "pushes the updated resources to an open connection when a gather command completes, with no reload",
  async () => {
    let before = await getState();
    before = await discoverResourceType(request, before, "sugar");
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
      let before = await getState();
      before = await discoverResourceType(request, before, "sugar");
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
    let before = await getState();
    before = await discoverResourceType(request, before, "sugar");
    // Stage 10 bugfix: fog of war means the sugar node discoverResourceType
    // found was only revealed because *some* worker's vision circle reached
    // it — not necessarily the arbitrary idle worker picked below. Picking
    // an unrelated worker and the globally-closest sugar node to it (which
    // may be a completely different, still-undiscovered-feeling node on the
    // far side of the world) could make this test wait out a full diagonal
    // crossing instead of the short hop vision discovery implies. Pick
    // whichever (idle worker, visible sugar node) pair is mutually nearest
    // instead, bounding travel to roughly a vision radius.
    const sugarNodes = before.resourceNodes.filter((n: any) => n.resourceType === "sugar");
    const idleWorkers = before.workers.filter((w: any) => !w.carrying);
    const candidates = (idleWorkers.length > 0 ? idleWorkers : before.workers) as any[];
    let worker = candidates[0];
    let node = sugarNodes[0];
    let bestDist = Infinity;
    for (const w of candidates) {
      for (const n of sugarNodes) {
        const dist = Math.hypot(w.x - n.x, w.y - n.y);
        if (dist < bestDist) {
          bestDist = dist;
          worker = w;
          node = n;
        }
      }
    }
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
it(
  "I: creature state is broadcast identically to every open connection, matching GET /api/state",
  async () => {
    // Stage 10: fog means a freshly-scouted colony only sees whatever
    // creatures fall within its vision — not the whole seeded world — so
    // this asserts "at least one visible creature, identical across
    // connections" rather than the pre-fog ">= 10" global-population count.
    let state = await getState();
    state = await discoverCreatures(request, state, { minCount: 1 });
    expect(Array.isArray(state.creatures)).toBe(true);
    expect(state.creatures.length).toBeGreaterThanOrEqual(1);

    const [wsA, wsB] = await Promise.all([connect(), connect()]);
    try {
      const [msgA, msgB] = await Promise.all([nextMessage(wsA, 3000), nextMessage(wsB, 3000)]);
      expect(Array.isArray(msgA.creatures)).toBe(true);
      const sortById = (list: any[]) => list.slice().sort((a, b) => a.id - b.id);
      expect(sortById(msgA.creatures)).toEqual(sortById(msgB.creatures));
    } finally {
      wsA.close();
      wsB.close();
    }
  },
  60000,
);

// Stage 5: I — aphid wandering is nobody-issued movement; it must still reach
// an open connection without a reload, proving creature advancement marks
// simulation state dirty for the broadcast loop same as worker movement does.
it(
  "I: aphid wandering is visible over an open WebSocket connection without a reload",
  async () => {
    let before = await getState();
    before = await discoverCreatures(request, before, { needSpecies: "aphid" });

    const ws = await connect();
    try {
      // Stage 10 bugfix: fog means the aphid found above is only visible
      // because one specific own worker's vision circle currently covers it
      // — unlike the pre-fog version of this test, it can wander back out of
      // range before ever being caught mid-step, and under full-suite
      // contention a single broadcast can also take a while to arrive. Give
      // this a generous outer budget, and if the originally-found aphid
      // drops out of vision, fall back to re-discovering (any) visible
      // aphid rather than failing outright — the test's actual claim is
      // "aphid wandering reaches an open connection," not "this exact aphid
      // specifically."
      const deadline = Date.now() + 50000;
      let moved = false;
      while (!moved && Date.now() < deadline) {
        const message = await nextMessage(ws, 20000).catch(() => null);
        if (!message) continue;
        moved = message.creatures.some((c: any) => {
          const start = before.creatures.find((b: any) => b.id === c.id);
          return start !== undefined && (c.x !== start.x || c.y !== start.y);
        });
        if (!moved) {
          // Track any newly-visible aphid as a fresh baseline too, so one
          // that wanders into view mid-test can still be used to detect
          // movement on a later frame.
          for (const c of message.creatures) {
            if (!before.creatures.some((b: any) => b.id === c.id)) {
              before.creatures.push(c);
            }
          }
        }
      }
      expect(moved).toBe(true);
    } finally {
      ws.close();
    }
  },
  90000,
);

// Stage 6: N -- combat rides the same broadcast channel as everything else.
// Health dropping, death, and the resulting carcass all arrive identically
// on every open connection, with no separate combat protocol.
it(
  "N: an attack's health drop, the creature's death, and its carcass are broadcast identically to every open connection",
  async () => {
    let before = await getState();
    before = await discoverCreatures(request, before, { minCount: 1 });
    const creature = before.creatures[0];
    // Stage 10 bugfix: fog of war means this colony's own view of `creature`
    // only exists because *some* own worker is currently within vision range
    // of it. Picking an arbitrary non-carrying worker (instead of the one
    // nearest to the creature) could pick one stationed far away — the long
    // travel time to close to attack range left the creature with no vision
    // source covering it for many frames in between, which `waitForDamaged`'s
    // "no current entry => must have died" fallback misread as an actual
    // death, and the test then hung waiting for a carcass that was never
    // going to appear. Picking the nearest own worker keeps the creature
    // continuously visible to this same session throughout the fight.
    const eligibleWorkers = before.workers.filter((w: any) => !w.carrying);
    const workerPool = eligibleWorkers.length > 0 ? eligibleWorkers : before.workers;
    const worker = workerPool.reduce((best: any, w: any) =>
      Math.hypot(w.x - creature.x, w.y - creature.y) < Math.hypot(best.x - creature.x, best.y - creature.y) ? w : best,
    );
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

      // Stage 10 bugfix: fog means a creature can drop out of this colony's
      // own view transiently (e.g. the attacking worker is still travelling
      // and no other own worker currently covers its position) without
      // actually having died. The old version here treated "missing from
      // this frame" as proof of death and returned immediately, which then
      // made the death/carcass wait below hang forever waiting for a death
      // that hadn't actually happened yet. Only an *observed health drop
      // while still present* counts as "damaged" now; a transient
      // disappearance is treated as "not there yet," not death — death is
      // only ever confirmed by waitForDeathAndCarcass below, via an actual
      // new carcass appearing.
      async function waitForDamaged(ws: WebSocket): Promise<any> {
        const deadline = Date.now() + 45000;
        while (Date.now() < deadline) {
          const message = await nextMessage(ws, 45000);
          const current = message.creatures.find((c: any) => c.id === creature.id);
          if (current && current.health < creature.maxHealth) return message;
          const carcass = message.resourceNodes.some(
            (n: any) => n.kind === "item" && n.resourceType === "protein" && !existingItemIds.has(n.id),
          );
          if (carcass) return message; // already dead and carcassed by the time we caught a frame
        }
        throw new Error("no broadcast frame showed the creature damaged or dead");
      }
      const [damagedA, damagedB] = await Promise.all([waitForDamaged(wsA), waitForDamaged(wsB)]);
      const liveA = damagedA.creatures.find((c: any) => c.id === creature.id);
      const liveB = damagedB.creatures.find((c: any) => c.id === creature.id);
      expect(liveA).toEqual(liveB);

      // Stage 10 bugfix: lengthened from 40s to accommodate full-suite
      // contention (slower polling cadence, plus potentially longer travel
      // to a creature discovered far from the nearest attacking worker) —
      // the attacker's chase target-reacquisition and the combat math
      // themselves are unchanged; this is purely a test-timing allowance.
      async function waitForDeathAndCarcass(ws: WebSocket): Promise<any> {
        const deadline = Date.now() + 90000;
        while (Date.now() < deadline) {
          const message = await nextMessage(ws, 90000);
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
  200000,
);

it(
  "a worker injured or killed by a spider is visible, as an otherWorkers health/presence change, to another colony's own open WebSocket connection",
  async () => {
    const colonyA = createOtherSession();
    const colonyB = createOtherSession();

    // Stage 10 bugfix (12): every previous attempt sent ordinary worker-caste
    // units from colony B to establish vision of A's fight — but
    // VISION_RADIUS.worker (180, see balance.ts) is strictly *less* than
    // SPIDER_AGGRO_RANGE (200), so any worker close enough to see the spider
    // (or the A worker it's attacking, which sits in the spider's melee
    // range) is by construction already inside the spider's aggro net. There
    // is no safe standoff distance for a worker-caste observer — this is why
    // B's own searchers kept dying (see dev-server action log: colony B
    // workers dying to spiders well before A's fight ever resolved). Scout's
    // VISION_RADIUS (400) is more than double SPIDER_AGGRO_RANGE (200),
    // giving a genuinely safe standoff band (just past 200, well within
    // 400) from which to watch the fight without ever entering aggro range.
    // Kick off gathering the extra protein and reproducing a scout for B
    // concurrently with A's own spider-discovery phase below, so the two
    // setup costs overlap instead of stacking serially.
    async function setupScoutForB(): Promise<void> {
      let bState = await getStateWith(colonyB.request);
      bState = await discoverResourceType(colonyB.request, bState, "protein");
      const scoutCost = bState.colony.reproduceCosts.scout;
      // Stage 10 bugfix (13): fog of war means a protein node discovered by
      // discoverResourceType above can drop back out of bState.resourceNodes
      // on a later poll if every worker that could see it wanders off again
      // (the same current-visibility-only semantics as everywhere else in
      // this file) — closestNode then throws "seed has no protein node"
      // instead of degrading gracefully, confirmed live in a full-suite run.
      // Remember every protein node position ever seen so far and pick the
      // nearest of those, not just whatever's in the current fog-filtered
      // snapshot — once a worker is dispatched toward a remembered node it
      // will regain vision of it well before arrival.
      const knownProteinNodes = new Map<number, any>();
      for (const n of bState.resourceNodes) {
        if (n.resourceType === "protein") knownProteinNodes.set(n.id, n);
      }
      const gatherDeadline = Date.now() + 60000;
      while (bState.colony.resources.protein < scoutCost && Date.now() < gatherDeadline) {
        for (const n of bState.resourceNodes) {
          if (n.resourceType === "protein") knownProteinNodes.set(n.id, n);
        }
        const idle = bState.workers.filter((w: any) => !w.carrying);
        for (const w of idle) {
          let nearest: any = null;
          let bestDist = Infinity;
          for (const n of knownProteinNodes.values()) {
            const dist = Math.hypot(n.x - w.x, n.y - w.y);
            if (dist < bestDist) {
              bestDist = dist;
              nearest = n;
            }
          }
          if (!nearest) continue;
          await colonyB.request("/api/command/gather", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ workerIds: [w.id], resourceId: nearest.id }),
          });
        }
        await new Promise((r) => setTimeout(r, 250));
        bState = await getStateWith(colonyB.request);
      }
      if (bState.colony.resources.protein < scoutCost) {
        throw new Error(`setupScoutForB: never gathered enough protein for a scout (have ${bState.colony.resources.protein}, need ${scoutCost})`);
      }
      const repRes = await colonyB.request("/api/reproduce", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caste: "scout" }),
      });
      if (repRes.status !== 200) {
        throw new Error(`setupScoutForB: reproduce(scout) failed with status ${repRes.status}`);
      }
      const scoutDeadline = Date.now() + 15000;
      while (Date.now() < scoutDeadline) {
        bState = await getStateWith(colonyB.request);
        if (bState.workers.some((w: any) => w.caste === "scout")) return;
        await new Promise((r) => setTimeout(r, 300));
      }
      throw new Error("setupScoutForB: scout never appeared in colony B's own workers");
    }
    const scoutSetupPromise = setupScoutForB();

    let aState = await colonyA.request("/api/state").then((r: any) => r.json());
    aState = await discoverCreatures(colonyA.request, aState, { needSpecies: "spider" });

    const aWorkers = aState.workers;
    const aWorkerIds = new Set(aWorkers.map((w: any) => w.id));
    expect(aWorkers.length, "colony A should start with at least one worker").toBeGreaterThan(0);
    const anySpider = aState.creatures.find((c: any) => c.species === "spider");
    expect(anySpider, "seed should always include at least one spider").toBeDefined();

    function nearestSpiderTo(creatures: any[], x: number, y: number, exclude?: Set<number>): any | null {
      const spiders = creatures.filter((c: any) => c.species === "spider" && !exclude?.has(c.id));
      if (spiders.length === 0) return null;
      return spiders.reduce((best: any, c: any) =>
        !best || Math.hypot(c.x - x, c.y - y) < Math.hypot(best.x - x, best.y - y) ? c : best,
      );
    }

    // Stage 10 bugfix (2): the spider pool is small, fixed, and never
    // respawns, and late in a long sequential full-suite run most of it can
    // already be permanently locked into "chase"/"chase-queen" against some
    // other colony far away by the time this test runs. A spider mid-chase
    // never re-scans for a new target (see advanceSpider), so if the
    // geometrically-nearest spider to one of A's workers happens to be one
    // of these permanently-busy ones, redirecting that worker at it over and
    // over never triggers aggro no matter how long or how often it's
    // retried. Track how long each candidate spider has sat assigned to a
    // still-uninjured worker with zero damage; once that exceeds
    // STUCK_SPIDER_TIMEOUT_MS, treat it as permanently busy and exclude it
    // from future assignments so workers fall through to the next-nearest
    // (genuinely idle) spider instead of stalling forever on one that can
    // never trigger.
    const STUCK_SPIDER_TIMEOUT_MS = 25000;
    const spiderFirstAssignedAt = new Map<number, number>();
    const blacklistedSpiders = new Set<number>();

    // Stage 10 bugfix: a spider's own idle/wander aggro-scan is the *only*
    // way it can ever select a new target, and that scan never runs while
    // the spider is already in a "chase"/"chase-queen" state. The spider
    // population is small, fixed, and never respawns — late in a long,
    // sequential full-suite run, most or all of them can already be dead or
    // permanently locked into some other colony's fight far away. Aiming
    // one single worker at whichever spider happens to be nearest to it can
    // pick exactly such a permanently-busy spider and then never see aggro
    // trigger, no matter how long it waits or how often it's redirected.
    // Spread every one of colony A's own workers across their own
    // individually-nearest spiders instead of funnelling all of them at one
    // shared target — this needs only one pairing, out of however many
    // workers this colony has, to land on a spider that's genuinely idle.
    // Also return the worker->spider assignments used, so colony B's own
    // searchers can be pointed at the exact same spiders A is approaching
    // (see dispatchBTo below) rather than at a derived "closest pair" point
    // that can flip targets every redirect cycle as different A workers
    // close in on different spiders at different rates — that instability
    // was itself a second, independently-discovered bug: B's searchers were
    // being yanked between wildly different locations every 7s and never
    // stayed near any one spot long enough to gain vision of anything.
    async function redirectWorkers(skipIds: Set<number>): Promise<{ state: any; assignments: Map<number, any> }> {
      const fresh = await colonyA.request("/api/state").then((r: any) => r.json());
      const now = Date.now();
      const liveSpiderIds = new Set(
        fresh.creatures.filter((c: any) => c.species === "spider").map((c: any) => c.id),
      );
      // A spider that's died (or was never real) can't be "stuck" — drop any
      // stale timers so a reused id from a later-seeded spider starts fresh.
      for (const id of spiderFirstAssignedAt.keys()) {
        if (!liveSpiderIds.has(id)) spiderFirstAssignedAt.delete(id);
      }
      const tasks: Promise<any>[] = [];
      const assignments = new Map<number, any>();
      for (const w of fresh.workers) {
        if (skipIds.has(w.id)) continue;
        let target = nearestSpiderTo(fresh.creatures, w.x, w.y, blacklistedSpiders);
        if (!target) {
          // Stage 10 bugfix (10): fog of war means A's own `/api/state` only
          // ever shows spiders within some worker's current vision circle —
          // immediately after every worker is recalled to the queen (bugfix
          // 8/9), NOT ONE spider is visible at all, by construction:
          // SPIDER_CLEAR_RADIUS (400, see balance.ts) is strictly larger than
          // VISION_RADIUS.queen (300), so a spider can never sit inside
          // queen-only vision. `nearestSpiderTo(fresh.creatures, ...)`
          // therefore returns null for every worker forever, `continue`
          // fires for all of them, and no move command is ever issued again
          // — a permanent deadlock, not a transient timing gap (confirmed:
          // every prior attempt's failing duration clustered well under the
          // engage loop's own 150s window, consistent with it spinning with
          // zero redirects the whole time). Fall back to the last confirmed
          // sighting (captured in `predictedTargets`, before any worker was
          // recalled, while the spider was still guaranteed visible) so
          // workers have somewhere to walk toward; once one of them closes
          // to within its own vision radius of the real spider, that spider
          // reappears in `fresh.creatures` on the next cycle and ordinary
          // live tracking takes back over.
          target = nearestSpiderTo(predictedTargets, w.x, w.y, blacklistedSpiders);
          if (!target) continue;
        }
        const firstAssigned = spiderFirstAssignedAt.get(target.id);
        if (firstAssigned === undefined) {
          spiderFirstAssignedAt.set(target.id, now);
        } else if (now - firstAssigned > STUCK_SPIDER_TIMEOUT_MS) {
          // This spider has been the nearest-available target for a healthy
          // worker for too long without producing any damage — it's almost
          // certainly already locked into a chase elsewhere. Blacklist it and
          // fall through to the next-nearest spider for this worker instead.
          blacklistedSpiders.add(target.id);
          spiderFirstAssignedAt.delete(target.id);
          target = nearestSpiderTo(fresh.creatures, w.x, w.y, blacklistedSpiders);
          if (!target) continue;
          if (!spiderFirstAssignedAt.has(target.id)) spiderFirstAssignedAt.set(target.id, now);
        }
        assignments.set(w.id, target);
        tasks.push(
          colonyA.request("/api/command/move", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ workerIds: [w.id], x: target.x, y: target.y }),
          }),
        );
      }
      await Promise.all(tasks);
      return { state: fresh, assignments };
    }

    function distinctTargets(assignments: Map<number, any>): any[] {
      const byId = new Map<number, any>();
      for (const spider of assignments.values()) {
        if (!byId.has(spider.id)) byId.set(spider.id, spider);
      }
      return [...byId.values()];
    }

    // Stage 10 bugfix (12), continued: the scout from setupScoutForB above
    // is the ONLY colony-B unit ever allowed near the fight. Every ordinary
    // worker is recalled to the queen on every dispatch (same safe-zone
    // reasoning as recallToQueen's own doc comment) so none of them can ever
    // wander into SPIDER_AGGRO_RANGE. The scout is sent to a point
    // STANDOFF_DIST away from the target, back toward the *scout's own
    // current position* (not toward B's queen, which is fixed and far away)
    // — deliberately so that as the fight target moves between dispatch
    // cycles and the standoff point is recomputed, the scout's straight-line
    // path to the new point is a radial approach/retreat relative to the
    // target: distance-to-target decreases monotonically from wherever the
    // scout currently stands down to exactly STANDOFF_DIST, never dipping
    // below it mid-transit. A queen-relative standoff point, by contrast,
    // can flip to the opposite side of the target as it moves, sending the
    // scout on a path that cuts straight through SPIDER_AGGRO_RANGE (200) —
    // confirmed this is exactly what killed the scout in the first attempt
    // at this fix (dev-server action log showed `worker_died {cause:
    // "spider"}` for the scout mid-engage-loop). STANDOFF_DIST (280) is
    // outside SPIDER_AGGRO_RANGE (200) with margin, while still comfortably
    // inside VISION_RADIUS.scout (400) to see the target and anything
    // fighting at it (melee range is tiny, ~30, so the real worker-vs-spider
    // action happens essentially at the target point).
    const STANDOFF_DIST = 280;
    function standoffPoint(target: any, from: { x: number; y: number }, dist: number): { x: number; y: number } {
      let dx = from.x - target.x;
      let dy = from.y - target.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) {
        dx = 1;
        dy = 0;
      } else {
        dx /= len;
        dy /= len;
      }
      return { x: target.x + dx * dist, y: target.y + dy * dist };
    }
    async function dispatchBTo(targets: any[]): Promise<void> {
      const freshB = await colonyB.request("/api/state").then((r: any) => r.json());
      if (freshB.workers.length === 0 || targets.length === 0) return;
      const scout = freshB.workers.find((w: any) => w.caste === "scout");
      if (!scout) return;
      const tasks: Promise<any>[] = [];
      for (const w of freshB.workers) {
        if (w.id !== scout.id) tasks.push(recallToQueen(colonyB.request, w, freshB));
      }
      const standoff = standoffPoint(targets[0], { x: scout.x, y: scout.y }, STANDOFF_DIST);
      tasks.push(
        colonyB.request("/api/command/move", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workerIds: [scout.id], x: standoff.x, y: standoff.y }),
        }),
      );
      await Promise.all(tasks);
    }

    const injured = new Set<number>();

    // Stage 10 bugfix (3): colony A's own bait workers can close to melee
    // range and kill a spider — and each other, workers-wise, die to it — in
    // as little as a couple of seconds once redirected toward it (three
    // hits at SPIDER_ATTACK_COOLDOWN apart). The *previous* version of this
    // test redirected A's workers onto a spider first and only afterward
    // spent up to 60s getting colony B's own vision established and its
    // WebSocket connected — meaning the fight (and the one narrow broadcast
    // frame showing a worker's health below max before it disappears
    // entirely) could complete well before B was even listening. Open B's
    // WebSocket and start redirecting both colonies in the same loop, from
    // the very first tick, so no frame is ever missed regardless of how
    // fast the fight resolves.
    // Stage 10 bugfix (7): `discoverCreatures` above leaves A's workers
    // mid-flight toward whatever grid-search waypoint they were last sent
    // to — it returns the instant a spider appears anywhere in state, with
    // no guarantee any worker has actually stopped moving. Left alone, they
    // keep walking toward that unrelated point for the entire pre-phase
    // below, so by the time the real engage loop starts, each worker's
    // "nearest spider" is computed from a drifted position that has nothing
    // to do with the spider B was told to wait near — explaining why
    // bugfixes (5) and (6) still failed even in an isolated run with no
    // full-suite travel-distance pressure at all.
    //
    // Stage 10 bugfix (8): a live tick-by-tick diagnostic trace against the
    // real server proved bugfix (7) alone still insufficient, and revealed
    // why: "freeze in place" (move-to-self) was implemented right after
    // `discoverCreatures` returns — i.e. wherever a grid-search waypoint
    // happened to leave a worker, which can land well inside
    // SPIDER_AGGRO_RANGE (200, see simulation.ts/balance.ts) of the very
    // spider just discovered. A spider's idle/wander aggro scan runs
    // unconditionally against every worker in that range regardless of
    // whether the test has issued any command — so a worker "frozen" that
    // close gets aggro'd and can be killed passively during the up-to-90s
    // wait phase below, entirely before colony B's WebSocket ever connects
    // (confirmed live: dev-server's action log showed exactly this
    // `worker_died {cause:"spider"}` mid-wait). With the predicted spider
    // dead, it vanishes from A's own fog-filtered creatures list (its only
    // remaining vision source was the now-dead worker itself), so the real
    // engage loop below ran its entire window against zero live spiders —
    // no fight ever happened, explaining `sawDamage: false` with flat,
    // unchanged worker health throughout.
    //
    // The actual fix is not to freeze workers wherever they happen to be,
    // but to recall them to the queen — the one position CLAUDE.md's Stage 7
    // section documents as structurally exempt from ambient spider aggro
    // (`isClearOfNests`/`SPIDER_CLEAR_RADIUS`, which gates the aggro
    // *trigger* itself, not just wander endpoints). This is the exact same
    // `recallToQueen` helper every other search phase in this file already
    // uses to keep its home-guard worker safe for the same reason — reusing
    // it here (for every worker, not just one guard) means A's whole roster
    // sits safely at the nest for the entire wait, with nothing able to
    // damage or kill them before the engage loop explicitly redirects them.
    //
    // Stage 10 bugfix (9): bugfix (8) then computed the predicted spider(s)
    // from `aStateAtQueen` — A's *own* state, re-fetched AFTER every worker
    // had already retreated to the queen. But `/api/state` is fog-filtered
    // for every caller, including a colony looking at its own creatures list
    // (Stage 10's fog has no persistent explored-map memory) — once every
    // worker sits at the queen, the spider `discoverCreatures` found can
    // easily be far outside every one of A's vision circles (workers are
    // placed well clear of every spawn anchor, see balance.ts's
    // SPIDER_CLEAR_RADIUS), so it silently vanishes from A's own
    // `creatures` array. `predictedSpiderIds` then comes back empty, and
    // `waitUntilBNear`'s own first line (`if (spiderIds.size === 0)
    // return`) fires almost immediately — explaining why every observed
    // failure's duration (~160-180s) landed well under the theoretical
    // ~240s ceiling (90s wait + 150s engage): the 90s pre-position phase was
    // being skipped essentially every time. The same blindness also meant
    // `waitUntilBNear`'s own per-iteration re-fetch of `freshA` (also
    // fog-filtered, also blind once A's workers are home) would have
    // defeated even a non-empty prediction via its `liveTargets.length ===
    // 0` branch on the very first loop iteration.
    //
    // The fix: capture the predicted target(s) from `aStateForFreeze` —
    // colony A's state from the instant *before* any recall command is
    // issued, while the just-discovered spider is still guaranteed visible
    // (that's the postcondition `discoverCreatures` just established) — and
    // never try to re-verify liveness through A's state again during the
    // wait phase (A is intentionally blind to it from here on). B simply
    // races toward this last-known position; the real, continuously-updated
    // redirection for both colonies only begins once the main engage loop
    // starts below, by which point A's workers are moving back toward the
    // spider themselves and regain genuine vision of it as they approach.
    const aStateForFreeze = await colonyA.request("/api/state").then((r: any) => r.json());
    const predictedAssignments = new Map<number, any>();
    for (const w of aStateForFreeze.workers) {
      const target = nearestSpiderTo(aStateForFreeze.creatures, w.x, w.y);
      if (target) predictedAssignments.set(w.id, target);
    }
    const predictedTargets = distinctTargets(predictedAssignments);

    await Promise.all(
      aStateForFreeze.workers.map((w: any) => recallToQueen(colonyA.request, w, aStateForFreeze)),
    );
    // Recalled workers haven't arrived yet the instant the commands above
    // are issued — give them time to actually reach the queen's safe zone
    // before the wait-and-observe phase below starts polling.
    await new Promise((r) => setTimeout(r, 3000));

    // Stage 10 bugfix (6): a single stale snapshot of the predicted spider's
    // position isn't perfect — spiders keep wandering continuously the whole
    // time A's workers sit un-commanded at the queen — but per bugfix (9)
    // above, A itself has no way to keep tracking it once its workers have
    // retreated out of vision range, so this is the best available intel:
    // race B toward the last confirmed position and rely on the 90s timeout
    // (not a liveness check) to bound the wait. If the spider has wandered
    // off or died by the time B arrives, the main engage loop below still
    // performs its own live, continuously-updated redirection for both
    // colonies from scratch.
    async function waitUntilBNear(targets: any[], thresholdDist: number, timeoutMs: number): Promise<void> {
      if (targets.length === 0) return;
      const deadline = Date.now() + timeoutMs;
      let lastDispatch = 0;
      while (Date.now() < deadline) {
        const freshB = await colonyB.request("/api/state").then((r: any) => r.json());
        if (freshB.workers.length === 0) return;
        const minDist = freshB.workers.reduce((min: number, w: any) => {
          const toTarget = Math.min(...targets.map((t: any) => Math.hypot(t.x - w.x, t.y - w.y)));
          return Math.min(min, toTarget);
        }, Infinity);
        if (minDist <= thresholdDist) return;
        if (Date.now() - lastDispatch > 2000) {
          await dispatchBTo(targets);
          lastDispatch = Date.now();
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    // Stage 10 bugfix (12), continued: the scout must actually exist before
    // dispatchBTo has anything to send — await its setup explicitly rather
    // than relying on waitUntilBNear's own polling loop to eventually catch
    // it appearing, so a setup failure (e.g. never enough protein) throws
    // here with a clear message instead of silently burning the 90s timeout.
    await scoutSetupPromise;

    // Threshold (300) sits comfortably inside VISION_RADIUS.scout (400, see
    // balance.ts) — once the scout is within 300 of the target it already
    // has vision of it regardless of the exact STANDOFF_DIST it parks at —
    // while staying well outside SPIDER_AGGRO_RANGE (200), so "near" here
    // never means "in aggro range."
    await waitUntilBNear(predictedTargets, 300, 90000);

    const wsB = await colonyB.connect();
    // Stage 10 bugfix (4): `ws.once("message", ...)` (as `nextMessage` used
    // here previously) only arms a listener for a single incoming frame —
    // any broadcast that arrives while nobody has called it yet (e.g. while
    // the loop below is busy awaiting the redirect/dispatch HTTP round
    // trips) has no listener attached and is silently dropped by Node's
    // EventEmitter; nothing buffers it for a later call. With as little as
    // ~2s between the first hit and death, a single dropped "injured" frame
    // is enough to produce exactly the observed `sawDamage: false`. Keep one
    // persistent listener queuing every frame, and drain the queue each
    // loop tick, so message *receipt* is decoupled from message
    // *processing* and no frame can be missed regardless of how long the
    // redirect calls take.
    const messageQueue: any[] = [];
    const onMessage = (data: any) => {
      try {
        const parsed = JSON.parse(data.toString());
        messageQueue.push(parsed);
      } catch {
        // ignore malformed frames
      }
    };
    wsB.on("message", onMessage);
    try {
      const deadline = Date.now() + 150000;
      let sawDamage = false;
      let sawDeath = false;
      let injuredWorkerId: number | null = null;
      let lastRedirect = 0;
      let aFresh = aState;
      let assignments = new Map<number, any>();
      let lastKnownTarget: any = null;
      while (!(sawDamage && sawDeath) && Date.now() < deadline) {
        while (messageQueue.length > 0) {
          const message = messageQueue.shift();
          if (injuredWorkerId === null) {
            const hit = message.otherWorkers.find(
              (w: any) => aWorkerIds.has(w.id) && typeof w.health === "number" && w.health < w.maxHealth,
            );
            if (hit) {
              injuredWorkerId = hit.id;
              injured.add(hit.id);
              sawDamage = true;
            }
          } else {
            const current = message.otherWorkers.find((w: any) => w.id === injuredWorkerId);
            if (!current) sawDeath = true;
          }
        }
        if (!(sawDamage && sawDeath)) {
          await new Promise((r) => setTimeout(r, 300));
        }
        if (!(sawDamage && sawDeath) && Date.now() - lastRedirect > 1500) {
          // Stage 10 bugfix: a spider keeps wandering continuously from its
          // own current position the whole time a worker travels toward it,
          // so a one-shot move can miss — keep re-aiming every still-healthy
          // worker at its own current nearest spider every redirect cycle,
          // until some pairing actually triggers aggro (observed via
          // sawDamage). Once a worker is injured, stop redirecting it (and
          // any already-flagged as such) so it doesn't get pulled off its
          // own attacker mid-fight.
          ({ state: aFresh, assignments } = await redirectWorkers(injured));

          let targets: any[];
          if (injuredWorkerId !== null) {
            // Stage 10 bugfix: once aggro has started, stop spreading B's
            // vision across every candidate spider and instead converge all
            // of B's searchers on the one spider actually attacking A's
            // injured worker — the spider closes to melee range and holds
            // position there once aggro'd, making it (not the two
            // equal-speed workers, which never converge) the stable
            // rendezvous point.
            const w = aFresh.workers.find((x: any) => x.id === injuredWorkerId);
            const spider = w ? nearestSpiderTo(aFresh.creatures, w.x, w.y) : null;
            targets = spider ? [spider] : w ? [w] : distinctTargets(assignments);
          } else {
            targets = distinctTargets(assignments);
          }
          // Stage 10 bugfix (11): once A's injured worker dies, `aFresh` no
          // longer contains it and `aFresh.creatures`/`assignments` can both
          // be empty too (A's own fog view goes blind the moment every one
          // of its workers near the fight is dead) — `targets` is then
          // empty on every subsequent cycle. Falling back to A's queen
          // position (the previous behaviour) sends B's searcher away from
          // wherever the fight actually happened, permanently out of range
          // of ever re-sighting the dying/dead worker. Remember the last
          // real target (spider or worker position) seen, and prefer that
          // over the queen so B continues converging on/holding near the
          // actual fight location instead of retreating to a point that was
          // never involved in it.
          if (targets.length) lastKnownTarget = targets[0];
          await dispatchBTo(
            targets.length ? targets : lastKnownTarget ? [lastKnownTarget] : [{ x: aFresh.colony.queenX, y: aFresh.colony.queenY }],
          );
          lastRedirect = Date.now();
        }
      }
      expect(sawDamage).toBe(true);
      expect(sawDeath).toBe(true);
    } finally {
      wsB.off("message", onMessage);
      wsB.close();
    }
  },
  // Stage 10: B now gets up to 90s to physically travel near the predicted
  // engagement site before A is ever redirected (bugfix 5), plus the
  // existing 150s combat-observation loop once both are in position, plus
  // setup/discovery overhead — give this test a generous outer budget,
  // especially under full-suite DB contention.
  260000,
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
    let bState = await colonyB.request("/api/state").then((r) => r.json());

    // Stage 10: the `colonies` roster is fog-filtered just like everything
    // else — B must scout A's queen position before A's roster entry (or its
    // eventual ruin) can appear in B's own payload at all.
    bState = await scoutToward(colonyB.request, bState, aState.colony.queenX, aState.colony.queenY, aState.colony.id);
    expect(
      bState.colonies.some((c: any) => c.id === aState.colony.id),
      "colony B never gained vision of colony A's queen",
    ).toBe(true);

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

      // Stage 10 bugfix: the scouting leg above (up to 60s) leaves colony A's
      // queen stationary and un-commanded the whole time, so under
      // full-suite contention an ambient spider can occasionally find and
      // kill her before this test ever gets to call abandon — the exact
      // queen-vulnerability CLAUDE.md's Stage 8 section documents as
      // deliberate, not a bug. abandon() itself already treats an
      // already-defeated colony as a 400 ("colony already defeated"), which
      // is a perfectly fine outcome here: the test's actual goal is just
      // "colony A ends up defeated and visible to B as a ruin," not
      // specifically that the abandon call itself is what defeats it.
      const abandonRes = await colonyA.request("/api/abandon", { method: "POST" });
      const freshAForAbandon = await colonyA.request("/api/state").then((r) => r.json());
      if (freshAForAbandon.colony.status !== "defeated") {
        expect(abandonRes.status).toBe(200);
      }

      const ruinMessage = await waitForColonyStatus(wsB, aState.colony.id, "defeated");
      expect(ruinMessage.colonies.find((c: any) => c.id === aState.colony.id)).toMatchObject({ status: "defeated" });
      // Alice's workers disappear from B's shared otherWorkers view too.
      expect(ruinMessage.otherWorkers.some((w: any) => w.colonyId === aState.colony.id)).toBe(false);

      const restartRes = await colonyA.request("/api/start-new-colony", { method: "POST" });
      expect(restartRes.status).toBe(200);
      const restarted = await restartRes.json();
      expect(restarted.colony.id).not.toBe(aState.colony.id);

      // The restarted colony lands at a fresh spiral position that may well
      // be outside B's existing vision (the ruin of A's old queen is still
      // visible, but that tells B nothing about where A's *new* queen is) —
      // B's workers need to actively scout toward it before its "active"
      // roster entry can appear in B's own payload. The final assertions
      // below need BOTH the old ruin and the new colony visible in the same
      // frame, so — unlike scoutToward's "send everyone" shape, which would
      // abandon the just-confirmed ruin — only redirect all but one worker,
      // leaving the rest parked at the ruin's position to keep it in view.
      bState = await getStateWith(colonyB.request);
      // Stage 10 bugfix: the worker actually holding vision of the ruin is
      // whichever one is physically closest to it — NOT necessarily
      // `bState.workers[0]` (the lowest-id worker). `scoutToward`'s own
      // internal `splitHomeGuard` recalls the lowest-id worker all the way
      // HOME to colony B's own queen and sends every *other* worker to the
      // ruin instead, so dropping index 0 here was actually releasing both
      // searchers that were parked at the ruin and leaving only the
      // recalled-home guard behind — losing the ruin's vision immediately.
      // Identify the worker nearest the ruin's own position and hold it
      // back; send everyone else toward the new colony.
      const ruinX = aState.colony.queenX;
      const ruinY = aState.colony.queenY;
      const ruinGuard = bState.workers.reduce(
        (closest: any, w: any) =>
          !closest || Math.hypot(w.x - ruinX, w.y - ruinY) < Math.hypot(closest.x - ruinX, closest.y - ruinY)
            ? w
            : closest,
        null,
      );
      const scoutsForNewColony = bState.workers.filter((w: any) => w.id !== ruinGuard?.id);
      if (scoutsForNewColony.length > 0) {
        await Promise.all(
          scoutsForNewColony.map((w: any) =>
            colonyB.request("/api/command/move", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ workerIds: [w.id], x: restarted.colony.queenX, y: restarted.colony.queenY }),
            }),
          ),
        );
      }
      // Stage 10 bugfix: a ruin protects nothing — `isClearOfNests` in
      // simulation.ts explicitly skips any colony whose status isn't
      // "active" ("a ruin protects nothing"), so the ruinGuard parked at
      // colony A's old queen position gets none of the spider-aggro
      // exclusion a worker standing at an *active* queen enjoys. Left
      // sitting there unattended for up to 60s, it's a perfectly ordinary
      // kill target for any ambient spider that wanders into range — once
      // it dies, B permanently loses vision of the ruin with nothing in the
      // original version of this loop to notice or recover. Periodically
      // re-identify whichever of B's currently-living workers is nearest
      // the ruin and (re)send it there if it isn't effectively already
      // guarding — this both replaces a guard that died and tolerates the
      // original guard having been reassigned by an earlier leg of the test.
      const REGUARD_MS = 7000;
      let lastReguard = 0;
      const newColonyDeadline = Date.now() + 60000;
      while (
        Date.now() < newColonyDeadline &&
        !(
          bState.colonies.some((c: any) => c.id === restarted.colony.id) &&
          bState.colonies.some((c: any) => c.id === aState.colony.id)
        )
      ) {
        if (Date.now() - lastReguard > REGUARD_MS) {
          const stillSeesRuin = bState.colonies.some((c: any) => c.id === aState.colony.id);
          if (!stillSeesRuin && bState.workers.length > 0) {
            const nearestToRuin = bState.workers.reduce(
              (closest: any, w: any) =>
                !closest || Math.hypot(w.x - ruinX, w.y - ruinY) < Math.hypot(closest.x - ruinX, closest.y - ruinY)
                  ? w
                  : closest,
              null,
            );
            if (nearestToRuin) {
              await colonyB.request("/api/command/move", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ workerIds: [nearestToRuin.id], x: ruinX, y: ruinY }),
              });
            }
          }
          lastReguard = Date.now();
        }
        await new Promise((r) => setTimeout(r, 500));
        bState = await getStateWith(colonyB.request);
      }
      expect(
        bState.colonies.some((c: any) => c.id === restarted.colony.id),
        "colony B never gained vision of colony A's restarted queen",
      ).toBe(true);
      expect(
        bState.colonies.some((c: any) => c.id === aState.colony.id),
        "colony B lost vision of colony A's old ruin while scouting toward the restarted queen",
      ).toBe(true);

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
  // Stage 10: this test now chains an initial scoutToward (up to 60s) plus a
  // second scout-while-keeping-vision-of-the-ruin loop (up to another 60s) on
  // top of the abandon/restart round trips — give it a generous outer budget.
  150000,
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
