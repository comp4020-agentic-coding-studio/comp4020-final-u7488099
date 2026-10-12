import express from "express";
import { readFileSync } from "node:fs";
import { WebSocket, WebSocketServer } from "ws";
import { reproduce } from "./actions.ts";
import { SIMULATION } from "./balance.ts";
import { getLog, logAction } from "./log.ts";
import { resolveOrCreateColony, SESSION_COOKIE } from "./sessions.ts";
import {
  advanceSimulation,
  checkpointSimulation,
  computeGroupDestinations,
  consumeDirty,
  issueAttackCommand,
  issueGatherCommand,
  issueMoveCommand,
} from "./simulation.ts";
import { getState } from "./state.ts";

// Crit 10: `colonyId` is the one fact every mutation trusts for
// authorization — resolved below, straight from the session cookie, never
// from anything the client sends in a request body. See CLAUDE.md's Crit 10
// section.
declare global {
  namespace Express {
    interface Request {
      colonyId: number;
    }
  }
}

const app = express();
app.use(express.json());

app.use(express.static("public"));
app.use(express.static("dist/client"));

// Crit 10 session middleware: resolves (or mints) the caller's own colony
// from their `sid` cookie before any `/api` route handler runs, and sets the
// cookie on first contact so the next request from the same browser profile
// resolves to the same colony. Scoped to `/api` only — static assets and
// `/readme/` don't need a colony, and never issuing a cookie there avoids
// minting a throwaway colony for e.g. a crawler fetching `/favicon.ico` with
// cookies disabled. No passwords/accounts — `sid` is an opaque random token,
// not an identity claim the client gets to assert the meaning of.
// `httpOnly` keeps it out of reach of any client-side JS/XSS; `sameSite:
// "lax"` is enough for a same-origin app with no cross-site form posts to
// defend against.
app.use("/api", (req, res, next) => {
  const { sessionId, colonyId, isNew } = resolveOrCreateColony(req.headers.cookie);
  req.colonyId = colonyId;
  if (isNew) {
    res.cookie(SESSION_COOKIE, sessionId, { httpOnly: true, path: "/", sameSite: "lax" });
  }
  next();
});

app.get("/readme/", (_req, res) => {
  const readme = readFileSync("README.md", "utf8");
  const escaped = readme.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  res.type("html").send(`<!doctype html>
<html lang="en-AU">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>About</title>
  </head>
  <body>
    <main>
      <h1>About</h1>
      <pre>
${escaped}
      </pre>
    </main>
  </body>
</html>
`);
});

app.get("/api/state", (req, res) => {
  res.json(getState(req.colonyId));
});

app.get("/api/log", (_req, res) => {
  res.json(getLog());
});

app.post("/api/reproduce", (req, res) => {
  const result = reproduce(req.colonyId);
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  logAction(req.colonyId, "reproduce");
  const state = getState(req.colonyId);
  broadcastState();
  res.json(state);
});

// Stage 2: a batch command never lets one bad id block the rest. Every id is
// attempted; ids that fail are collected into `errors` rather than aborting
// the loop. Only when *every* id fails does the whole request 400 — if at
// least one succeeded, the response is 200 with the resulting state plus
// `errors` naming exactly which ids didn't go through. See CLAUDE.md.
//
// Crit 10: `issue` is always called with the caller's own `colonyId`
// (resolved server-side from their session, never from the request body) so
// ownership enforcement lives once, inside simulation.ts's
// issueMoveCommand/issueGatherCommand/issueAttackCommand, not duplicated
// here per route. Every attempted batch is logged once, successes and
// failures together — "who tried what" is the useful signal, not just "who
// succeeded".
function runBatchCommand<E extends string>(
  res: express.Response,
  colonyId: number,
  action: string,
  workerIds: number[],
  issue: (workerId: number, colonyId: number) => E | null,
): void {
  const errors: Record<number, E> = {};
  for (const workerId of workerIds) {
    const error = issue(workerId, colonyId);
    if (error) errors[workerId] = error;
  }

  const succeeded = workerIds.length - Object.keys(errors).length;
  logAction(colonyId, action, { workerIds, errors });
  if (succeeded === 0) {
    res.status(400).json({ error: Object.values(errors)[0], errors });
    return;
  }

  const state = getState(colonyId);
  broadcastState();
  res.json(Object.keys(errors).length > 0 ? { ...state, errors } : state);
}

app.post("/api/command/move", (req, res) => {
  const { workerIds, x, y } = req.body ?? {};
  if (!Array.isArray(workerIds) || workerIds.length === 0 || !workerIds.every((id) => typeof id === "number")) {
    res.status(400).json({ error: "workerIds must be a non-empty array of numbers" });
    return;
  }
  if (typeof x !== "number" || typeof y !== "number") {
    res.status(400).json({ error: "x and y are required" });
    return;
  }
  // Stage 3: the clicked point is the centre of a loose destination area,
  // not a shared exact target — each worker gets its own nearby slot (a
  // lone worker's slot is the exact centre, unchanged from Stage 2). See
  // simulation.ts.
  const destinations = computeGroupDestinations(workerIds, x, y);
  runBatchCommand(res, req.colonyId, "move", workerIds, (workerId, colonyId) => {
    const destination = destinations.get(workerId)!;
    return issueMoveCommand(workerId, destination.x, destination.y, colonyId);
  });
});

// Preferred, and now only, gather entry point: issues a gather command that
// travels toward the resource and claims it on arrival (see
// simulation.ts). Replaces Stage 1's instant, transitional POST /api/gather.
app.post("/api/command/gather", (req, res) => {
  const { workerIds, resourceId } = req.body ?? {};
  if (!Array.isArray(workerIds) || workerIds.length === 0 || !workerIds.every((id) => typeof id === "number")) {
    res.status(400).json({ error: "workerIds must be a non-empty array of numbers" });
    return;
  }
  if (typeof resourceId !== "number") {
    res.status(400).json({ error: "resourceId is required" });
    return;
  }
  runBatchCommand(res, req.colonyId, "gather", workerIds, (workerId, colonyId) =>
    issueGatherCommand(workerId, resourceId, colonyId),
  );
});

// Stage 6: same batch-command contract as move/gather. Attack is ephemeral
// (see simulation.ts) — nothing here persists beyond issuing the command;
// chasing, range/cooldown resolution, and damage all happen in the existing
// advanceSimulation tick, with no new interval.
app.post("/api/command/attack", (req, res) => {
  const { workerIds, creatureId } = req.body ?? {};
  if (!Array.isArray(workerIds) || workerIds.length === 0 || !workerIds.every((id) => typeof id === "number")) {
    res.status(400).json({ error: "workerIds must be a non-empty array of numbers" });
    return;
  }
  if (typeof creatureId !== "number") {
    res.status(400).json({ error: "creatureId is required" });
    return;
  }
  runBatchCommand(res, req.colonyId, "attack", workerIds, (workerId, colonyId) =>
    issueAttackCommand(workerId, creatureId, colonyId),
  );
});

const port = Number(process.env.PORT ?? 8080);
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`listening on http://0.0.0.0:${port}`);
});

const wss = new WebSocketServer({ server, path: "/ws" });

// Crit 10: each connection belongs to a different colony now, so there is no
// longer one shared JSON payload to fan out — every connection is tagged
// with its own `colonyId`, resolved once at handshake time from the same
// session cookie the client's HTTP requests already carry (never from
// anything the client sends over the socket itself) and cached on the
// connection for the rest of its lifetime.
const connectionColonyIds = new Map<WebSocket, number>();

wss.on("connection", (ws, req) => {
  const { colonyId } = resolveOrCreateColony(req.headers.cookie);
  connectionColonyIds.set(ws, colonyId);
  ws.on("close", () => connectionColonyIds.delete(ws));
  // No immediate send here: a connection's first frame always comes from the
  // next periodic broadcast below, same as every pre-Crit-10 connection. Two
  // connections for the same colony opened moments apart must see bit-
  // identical state (spec/realtime.test.ts, test I) — sending independently
  // here would let one connection's snapshot land a tick before another's.
});

// One `getState(colonyId)` call per distinct colony per broadcast tick, not
// per client — multiple connections sharing a colony get the exact same
// serialized string, which is what makes "broadcast identically to every
// open connection" (spec/realtime.test.ts) true by construction rather than
// by chance timing.
function broadcastState(): void {
  const payloads = new Map<number, string>();
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    const colonyId = connectionColonyIds.get(client);
    if (colonyId === undefined) continue;
    let payload = payloads.get(colonyId);
    if (payload === undefined) {
      payload = JSON.stringify(getState(colonyId));
      payloads.set(colonyId, payload);
    }
    client.send(payload);
  }
}

// Tick faster than broadcast: positions update smoothly in memory even
// though clients only see a new frame at SIMULATION.broadcastHz. Both run
// as plain setIntervals in the single server process — advanceSimulation is
// fully synchronous, so it can never interleave with an HTTP handler's own
// mutation. See simulation.ts / CLAUDE.md.
setInterval(() => advanceSimulation(1 / SIMULATION.tickHz), 1000 / SIMULATION.tickHz);

// Only pushes a frame when something actually moved, so an idle world
// doesn't broadcast identical state forever.
setInterval(() => {
  if (consumeDirty()) broadcastState();
}, 1000 / SIMULATION.broadcastHz);

// Positions live in memory and are only periodically flushed to SQLite —
// writing every tick would turn continuous movement into a continuous write
// load. SIGTERM/SIGINT also checkpoint so a graceful restart never loses
// more than one interval's worth of movement.
setInterval(() => checkpointSimulation(), SIMULATION.checkpointIntervalMs);

function shutdown(): void {
  checkpointSimulation();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
