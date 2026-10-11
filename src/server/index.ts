import express from "express";
import { readFileSync } from "node:fs";
import { WebSocket, WebSocketServer } from "ws";
import { gather, reproduce } from "./actions.ts";
import { SIMULATION } from "./balance.ts";
import { advanceSimulation, checkpointSimulation, consumeDirty, issueMoveCommand } from "./simulation.ts";
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

app.post("/api/gather", (req, res) => {
  const { workerId, nodeId } = req.body ?? {};
  if (typeof workerId !== "number" || typeof nodeId !== "number") {
    res.status(400).json({ error: "workerId and nodeId are required" });
    return;
  }
  const result = gather(workerId, nodeId);
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  const state = getState();
  broadcastState(state);
  res.json(state);
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

// Stage 1b: single-worker-only in the UI, but the array shape is kept so
// Stage 2 (group selection) can reuse this route unchanged.
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
  for (const workerId of workerIds) {
    const error = issueMoveCommand(workerId, x, y);
    if (error) {
      res.status(400).json({ error });
      return;
    }
  }
  const state = getState();
  broadcastState(state);
  res.json(state);
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
