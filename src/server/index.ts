import express from "express";
import { readFileSync } from "node:fs";
import { WebSocket, WebSocketServer } from "ws";
import { reproduce } from "./actions.ts";
import { SIMULATION } from "./balance.ts";
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

const app = express();
app.use(express.json());
app.use(express.static("public"));
app.use(express.static("dist/client"));

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

app.get("/api/state", (_req, res) => {
  res.json(getState());
});

app.post("/api/reproduce", (_req, res) => {
  const { colony } = getState();
  const result = reproduce(colony.id);
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  const state = getState();
  broadcastState(state);
  res.json(state);
});

// Stage 2: a batch command never lets one bad id block the rest. Every id is
// attempted; ids that fail are collected into `errors` rather than aborting
// the loop. Only when *every* id fails does the whole request 400 — if at
// least one succeeded, the response is 200 with the resulting state plus
// `errors` naming exactly which ids didn't go through. See CLAUDE.md.
function runBatchCommand<E extends string>(
  res: express.Response,
  workerIds: number[],
  issue: (workerId: number) => E | null,
): void {
  const errors: Record<number, E> = {};
  for (const workerId of workerIds) {
    const error = issue(workerId);
    if (error) errors[workerId] = error;
  }

  const succeeded = workerIds.length - Object.keys(errors).length;
  if (succeeded === 0) {
    res.status(400).json({ error: Object.values(errors)[0], errors });
    return;
  }

  const state = getState();
  broadcastState(state);
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
  runBatchCommand(res, workerIds, (workerId) => {
    const destination = destinations.get(workerId)!;
    return issueMoveCommand(workerId, destination.x, destination.y);
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
  runBatchCommand(res, workerIds, (workerId) => issueGatherCommand(workerId, resourceId));
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
  runBatchCommand(res, workerIds, (workerId) => issueAttackCommand(workerId, creatureId));
});

const port = Number(process.env.PORT ?? 8080);
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`listening on http://0.0.0.0:${port}`);
});

const wss = new WebSocketServer({ server, path: "/ws" });

function broadcastState(state: ReturnType<typeof getState>): void {
  const payload = JSON.stringify(state);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
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
  if (consumeDirty()) broadcastState(getState());
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
