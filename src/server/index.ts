import express from "express";
import { readFileSync } from "node:fs";
import { WebSocket, WebSocketServer } from "ws";
import { abandon, reproduce, selectEvolution } from "./actions.ts";
import { login, logout, peekIdentity, register, resetProgress, resolveIdentity } from "./auth.ts";
import { ECOLOGY_EVAL_INTERVAL_MS, SIMULATION } from "./balance.ts";
import { db, getAllAccounts, getColonyForSession, resetProductionWorld } from "./db.ts";
import { activeExclusionCircles, advanceEcology, anchorGeometry, getEcologySnapshot, resetEcologyState } from "./ecology.ts";
import { getEcologyConfig, setEcologyConfig, validateEcologyConfigInput } from "./ecologyConfig.ts";
import { getLog, logAction } from "./log.ts";
import { resolveOrCreateColony, SESSION_COOKIE, startNewColony } from "./sessions.ts";
import {
  advanceSimulation,
  checkpointSimulation,
  computeGroupDestinations,
  consumeDirty,
  defeatColony,
  getAllColonies,
  getAllWorkersWithColony,
  getCreaturesForWorld,
  issueAttackCommand,
  issueGatherCommand,
  issueMoveCommand,
  loadSimulation,
} from "./simulation.ts";
import { getState } from "./state.ts";

// Crit 10: `colonyId` is the one fact every mutation trusts for
// authorization — resolved below, straight from the session cookie, never
// from anything the client sends in a request body. See CLAUDE.md's Crit 10
// section. `sessionId` (Stage 8) is needed only by startNewColony, which
// must re-point the caller's own session row — also always resolved
// server-side, never accepted from the request body.
// Stage 11: accountId/role/username are the same kind of server-resolved
// fact — always derived fresh from the session row by the middleware below,
// never trusted from a header/body/query param. null for a guest session.
declare global {
  namespace Express {
    interface Request {
      colonyId: number;
      sessionId: string;
      accountId: number | null;
      role: "player" | "admin" | null;
      username: string | null;
    }
  }
}

// Stage 11: the small identity summary attached to every HTTP response that
// carries colony state — the client's in-game indicator (Guest vs. username)
// and its admin-link gating both read this. Built straight from fields the
// session middleware already resolved this request, so it's free (no extra
// DB lookup). Deliberately NOT folded into getState()/ColonyState itself:
// identity is per-session, but broadcastState() below caches one getState()
// payload per colonyId shared across every connection on that colony (see
// its own comment) — a colony has exactly one current owner at a time, but
// threading identity through that shared-by-colonyId cache would need a
// reverse session/account lookup for no real benefit, since a client's
// identity only ever changes via an auth HTTP route, and the client always
// follows one of those with a fresh GET /api/state (see WS transition
// handling). WebSocket frames carry plain ColonyState, with no identity.
function requestIdentity(req: express.Request): { status: "guest" | "account"; username: string | null; role: "player" | "admin" | null } {
  return req.accountId != null
    ? { status: "account", username: req.username, role: req.role }
    : { status: "guest", username: null, role: null };
}

const app = express();
app.use(express.json());

app.use(express.static("public"));
app.use(express.static("dist/client"));

// Stage 11: the admin page lives at the exact path /admin (not /admin.html)
// per the plan's wording — static serving alone would only reach it at the
// .html path, so this route sends the same file explicitly. The real
// authorization gate is still server-side (requireAdmin on every
// /api/admin/* route below); this route serves the shell to anyone, same as
// index.html does for the game, since the shell itself carries no data.
app.get("/admin", (_req, res) => {
  res.sendFile("admin.html", { root: "public" });
});

// Stage 11: GET /api/session is the one read-only, non-minting identity
// check — a first-time visitor must see "anonymous" with no session/colony
// minted just for asking, so the client's entry gate can decide whether to
// show Guest/Register/Login before any game state exists. Registered ahead
// of the minting middleware below, on the exact path only, so it never
// passes through that middleware's unconditional resolveIdentity() call.
app.get("/api/session", (req, res) => {
  res.json(peekIdentity(req.headers.cookie));
});

// Crit 10 session middleware: resolves (or mints) the caller's own colony
// from their `sid` cookie before any other `/api` route handler runs, and
// sets the cookie on first contact so the next request from the same
// browser profile resolves to the same colony. Scoped to `/api` only —
// static assets and `/readme/` don't need a colony, and never issuing a
// cookie there avoids minting a throwaway colony for e.g. a crawler fetching
// `/favicon.ico` with cookies disabled. No passwords/accounts — `sid` is an
// opaque random token, not an identity claim the client gets to assert the
// meaning of. `httpOnly` keeps it out of reach of any client-side JS/XSS;
// `sameSite: "lax"` is enough for a same-origin app with no cross-site form
// posts to defend against.
// Stage 11: resolveIdentity() supersedes resolveOrCreateColony() here,
// additionally resolving accountId/role fresh from the session row — every
// other /api/* route (including the auth routes themselves) still gets a
// colony minted on first contact exactly as before; only GET /api/session
// above is exempt from minting.
app.use("/api", (req, res, next) => {
  const { sessionId, colonyId, accountId, role, username, isNew } = resolveIdentity(req.headers.cookie);
  req.colonyId = colonyId;
  req.sessionId = sessionId;
  req.accountId = accountId;
  req.role = role;
  req.username = username;
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
  res.json({ ...getState(req.colonyId), identity: requestIdentity(req) });
});

app.get("/api/log", (_req, res) => {
  res.json(getLog());
});

// Stage 11: explicit "Continue as Guest" — idempotent. The minting
// middleware above has already minted a guest session for this request if
// none existed, so this route's entire job is just to report that back; a
// returning guest/account session gets the exact same response as any other
// /api/session-adjacent check.
// Reads identity from req (already resolved by the minting middleware above),
// not by re-parsing req.headers.cookie — when this request itself just
// minted a brand-new session, the Set-Cookie is only on the *response*, so
// re-parsing the incoming request's cookie header here would still see no
// cookie and misreport "anonymous" on a session's very first contact.
app.post("/api/auth/guest", (req, res) => {
  res.json(requestIdentity(req));
});

app.post("/api/auth/register", (req, res) => {
  const { username, password } = req.body ?? {};
  const result = register(req.sessionId, username, password);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  broadcastState();
  res.json({ username: result.username, role: result.role });
});

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body ?? {};
  const result = login(req.sessionId, username, password);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  broadcastState();
  res.json({ username: result.username, role: result.role });
});

app.post("/api/auth/logout", (req, res) => {
  const result = logout(req.sessionId);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  broadcastState();
  res.json({ ok: true });
});

// Stage 11: requires an exact typed confirmation, deliberately stronger than
// Abandon Colony's plain confirm — this is a player explicitly discarding
// their own progress, not reacting to a defeat that already happened.
app.post("/api/account/reset-progress", (req, res) => {
  const { confirm } = req.body ?? {};
  const result = resetProgress(req.sessionId, req.accountId, req.colonyId, confirm);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  const state = getState(result.colonyId);
  broadcastState();
  res.json({ ...state, identity: requestIdentity(req) });
});

// Stage 11: every /api/admin/* route sits behind this one guard. req.role is
// always resolved server-side by the /api middleware above, straight from
// the session's account row (resolveIdentity -> accounts.role) — never
// trusted from a header/body/query param, same discipline Crit 10 already
// established for colonyId. A non-admin (including every guest, and every
// logged-in "player") gets the exact same generic 403 whether or not the
// route itself even applies to them, so there's nothing to probe.
function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (req.role !== "admin") {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  next();
}

// Every SELECT below reuses an existing safe accessor (getAllAccounts's
// explicit-column query, getAllColonies, getLog) — none of them is
// `SELECT *`, so password_hash/password_salt can never leak into an admin
// response by accident. See db.ts's ACCOUNT_COLUMNS/getAllAccounts comment.
app.get("/api/admin/stats", requireAdmin, (_req, res) => {
  const colonies = getAllColonies();
  res.json({
    accounts: getAllAccounts().length,
    colonies: {
      total: colonies.length,
      active: colonies.filter((c) => c.status === "active").length,
      defeated: colonies.filter((c) => c.status === "defeated").length,
    },
    actionLogRows: getLog().length,
  });
});

app.get("/api/admin/accounts", requireAdmin, (_req, res) => {
  res.json(getAllAccounts());
});

app.get("/api/admin/colonies", requireAdmin, (_req, res) => {
  res.json(getAllColonies());
});

// Bounded to the most recent 200 entries, newest first — getLog() itself
// stays unbounded (GET /api/log's existing public contract), but an admin
// table shouldn't have to render every row ever written as action_log grows.
app.get("/api/admin/log", requireAdmin, (_req, res) => {
  res.json(getLog().slice(-200).reverse());
});

// Stage 12: read-only ecology diagnostic — computed on demand from the same
// read path advanceEcology itself uses, never stored. No controls here, just
// visibility into per-zone density/target/pending-regen state.
app.get("/api/admin/ecology", requireAdmin, (_req, res) => {
  res.json(getEcologySnapshot());
});

// Stage 12.5B: the admin map's single data source. Deliberately not a
// reuse/extension of GET /api/state — that route is per-colony (resources,
// evolution, reproduce costs), while this one is world-scoped and
// read-only. Cost is O(resourceNodes + creatures + colonies), one query
// each, same shape as getState's own queries — no per-zone SQLite round
// trip and no per-frame recomputation (the admin client polls this on a
// ~1.5s timer, not per animation frame). Units (workers) are the one
// potentially large, growing dataset, so they're only included when the
// client explicitly asks via ?units=1 — satisfies "Units should default
// OFF for performance" at the network layer, not just the render layer.
app.get("/api/admin/world-monitor", requireAdmin, (req, res) => {
  const world = db.prepare("SELECT id, width, height FROM worlds LIMIT 1").get() as
    | { id: number; width: number; height: number }
    | undefined;
  if (!world) {
    res.status(404).json({ error: "no world seeded" });
    return;
  }
  const resourceNodes = db
    .prepare("SELECT id, x, y, resource_type AS resourceType, kind FROM resource_nodes WHERE world_id = ? ORDER BY id")
    .all(world.id) as { id: number; x: number; y: number; resourceType: string; kind: "source" | "item" }[];
  const payload: Record<string, unknown> = {
    world: { width: world.width, height: world.height },
    anchors: anchorGeometry(),
    resourceNodes,
    creatures: getCreaturesForWorld(world.id),
    colonies: getAllColonies(),
    exclusions: activeExclusionCircles(Date.now()),
  };
  if (req.query.units === "1") {
    payload.workers = getAllWorkersWithColony();
  }
  res.json(payload);
});

app.get("/api/admin/ecology-config", requireAdmin, (_req, res) => {
  res.json(getEcologyConfig());
});

// Stage 12.5B: the only write path for the persisted ecology knobs (ten
// independent per-anchor base targets plus background/regen min/max — see
// ecologyConfig.ts for exactly which, and CLAUDE.md for why no others are
// exposed here). Validated and rejected atomically — never a
// partial write — and logged with a human-readable before/after detail
// object, same colonyId=0 "world-scoped action" convention admin_reset_world
// already established. Saving this config never touches worlds/colonies/
// resource_nodes/creatures — it only changes what future ecology ticks
// target, never resets or reseeds anything that already exists.
app.put("/api/admin/ecology-config", requireAdmin, (req, res) => {
  const body = (req.body ?? {}) as Partial<
    Record<"anchorBaseTargets" | "backgroundBaseTarget" | "regenDelayMinMs" | "regenDelayMaxMs", unknown>
  >;
  const error = validateEcologyConfigInput(body);
  if (error) {
    res.status(400).json({ error });
    return;
  }
  const input = {
    anchorBaseTargets: body.anchorBaseTargets as number[],
    backgroundBaseTarget: body.backgroundBaseTarget as number,
    regenDelayMinMs: body.regenDelayMinMs as number,
    regenDelayMaxMs: body.regenDelayMaxMs as number,
  };
  const before = getEcologyConfig();
  const after = setEcologyConfig(input);
  logAction(
    0,
    "admin_update_ecology_config",
    {
      from: {
        anchorBaseTargets: before.anchorBaseTargets,
        backgroundBaseTarget: before.backgroundBaseTarget,
        regenDelayMinMs: before.regenDelayMinMs,
        regenDelayMaxMs: before.regenDelayMaxMs,
      },
      to: input,
    },
    req.accountId ?? undefined,
  );
  res.json(after);
});

// Reuses the exact same idempotent defeatColony() pipeline every other
// colony-ending path (lethal queen hit, Abandon Colony) already goes
// through — "admin" is just a new defeat_cause literal, not a parallel
// destructive code path. A nonexistent id is reported as 404 rather than a
// silent no-op, since an admin operator (unlike a player's own session)
// has no other way to notice the id was wrong.
app.post("/api/admin/colonies/:id/defeat", requireAdmin, (req, res) => {
  const colonyId = Number(req.params.id);
  if (!Number.isInteger(colonyId)) {
    res.status(400).json({ error: "invalid colony id" });
    return;
  }
  if (!getAllColonies().some((c) => c.id === colonyId)) {
    res.status(404).json({ error: "no such colony" });
    return;
  }
  defeatColony(colonyId, "admin");
  logAction(colonyId, "admin_defeat_colony", undefined, req.accountId ?? undefined);
  broadcastState();
  res.json({ ok: true });
});

// The one genuinely destructive admin action. Deliberately requires the
// literal "RESET WORLD" — distinct from player Reset Progress's "RESET" —
// so the two can never be confused and a copy-pasted player confirmation
// can't accidentally trigger this one. Calls the existing, already-safe
// resetProductionWorld() in-process (same function scripts/reset-world.ts
// uses) rather than shelling out, per the plan. After it commits, every
// open WebSocket connection is force-closed — unlike every other identity
// transition (login/logout/register), which is client-driven reconnect,
// this one can invalidate *other* players' sessions out from under them,
// so the server proactively closes every socket; each client's own
// ws.on("close", ...) handler re-runs its bootstrap and degrades a now-
// unrecognized session to the entry gate (see sessions.ts's existing
// precedent for a wiped session resolving safely).
//
// IMPORTANT: this route must never be invoked by anything other than a
// real admin operator deliberately clicking the confirmed control in the
// live /admin UI — never during implementation, testing against the dev
// DB, or deployment.
app.post("/api/admin/reset-world", requireAdmin, (req, res) => {
  const { confirm } = req.body ?? {};
  if (confirm !== "RESET WORLD") {
    res.status(400).json({ error: 'confirmation must be exactly "RESET WORLD"' });
    return;
  }
  const result = resetProductionWorld();
  // resetProductionWorld() only rewrites the DB; loadSimulation() is
  // otherwise called once, at server startup (see scripts/reset-world.ts's
  // own warning about this for the CLI path). Without re-running it here,
  // the in-memory colonies/workers/creatures Maps keep serving the
  // pre-reset world — stale colonies that look "active" to every in-memory
  // read path (getAllColonies(), the admin defeat route's existence check,
  // defeatColony()'s own guard) even though their DB rows are long gone.
  loadSimulation();
  resetEcologyState();
  logAction(0, "admin_reset_world", result, req.accountId ?? undefined);
  for (const client of wss.clients) {
    client.close();
  }
  res.json({ ok: true, ...result });
});

app.post("/api/reproduce", (req, res) => {
  // Stage 10: the client requests a caste, never colony authority —
  // req.colonyId still resolves exclusively from session middleware above.
  const { caste } = (req.body ?? {}) as { caste?: unknown };
  if (caste !== "worker" && caste !== "soldier" && caste !== "scout") {
    res.status(400).json({ ok: false, error: "invalid caste" });
    return;
  }
  const result = reproduce(req.colonyId, caste);
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  logAction(req.colonyId, "reproduce", { caste });
  const state = getState(req.colonyId);
  broadcastState();
  res.json({ ...state, identity: requestIdentity(req) });
});

// Stage 8: the manual counterpart to a lethal spider hit — same
// authoritative defeatColony() pipeline underneath (see actions.ts), same
// session-resolved-colonyId shape every other route already uses. Does NOT
// require the caller to have a worker or any resources, per §36.
app.post("/api/abandon", (req, res) => {
  const result = abandon(req.colonyId);
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  const state = getState(req.colonyId);
  broadcastState();
  res.json({ ...state, identity: requestIdentity(req) });
});

// Stage 8: eligibility is "valid session + defeated current colony", not
// resource balance (§14) — startNewColony() itself enforces this and logs
// colony_started. The new colony id is never accepted from the request
// body; it's whatever startNewColony() mints/claims server-side.
app.post("/api/start-new-colony", (req, res) => {
  const result = startNewColony(req.sessionId, req.colonyId);
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  const state = getState(result.colonyId);
  broadcastState();
  res.json({ ...state, identity: requestIdentity(req) });
});

// Stage 9 §8: body carries only {tier, choice} — colonyId is always
// resolved from the session middleware, never trusted from the client, same
// discipline as every other mutating route.
app.post("/api/evolve", (req, res) => {
  const { tier, choice } = req.body ?? {};
  if (typeof tier !== "number" || typeof choice !== "string") {
    res.status(400).json({ error: "tier and choice are required" });
    return;
  }
  const result = selectEvolution(req.colonyId, tier, choice);
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  const state = getState(req.colonyId);
  broadcastState();
  res.json({ ...state, identity: requestIdentity(req) });
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
  req: express.Request,
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

  const state = { ...getState(colonyId), identity: requestIdentity(req) };
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
  runBatchCommand(req, res, req.colonyId, "move", workerIds, (workerId, colonyId) => {
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
  runBatchCommand(req, res, req.colonyId, "gather", workerIds, (workerId, colonyId) =>
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
  runBatchCommand(req, res, req.colonyId, "attack", workerIds, (workerId, colonyId) =>
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
// with its owning `sessionId`, resolved once at handshake time from the same
// session cookie the client's HTTP requests already carry (never from
// anything the client sends over the socket itself).
//
// Stage 8: the *session* id is cached, not the colony id. A session's
// `sid` cookie never changes for the lifetime of a connection, but which
// colony it currently owns can — Start New Colony re-points a session's row
// to a fresh colony id (sessions.ts) without touching its cookie. Caching
// `colonyId` itself (the pre-Stage-8 design) meant an already-open socket
// kept broadcasting a now-defeated colony's state forever after a restart,
// since nothing ever re-resolved it. Re-deriving `colonyId` from the cached
// `sessionId` on every broadcast tick (one indexed `sessions` lookup per
// connection, same cost as the per-request HTTP resolution already does) is
// what lets a restart appear over the live socket with no reload. See
// spec/realtime.test.ts's "a colony's own defeat and subsequent restart are
// each broadcast directly to its own open WebSocket connection".
const connectionSessionIds = new Map<WebSocket, string>();

wss.on("connection", (ws, req) => {
  const { sessionId } = resolveOrCreateColony(req.headers.cookie);
  connectionSessionIds.set(ws, sessionId);
  ws.on("close", () => connectionSessionIds.delete(ws));
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
    const sessionId = connectionSessionIds.get(client);
    if (sessionId === undefined) continue;
    const colonyId = getColonyForSession(sessionId);
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

// Stage 12: ecology evaluation is deliberately its own, much slower interval
// (~5s), decoupled from the 10Hz hot loop above — a global pass over every
// resource node/creature belongs nowhere near tickHz. See ecology.ts /
// CLAUDE.md's Stage 12 section for why this can't just ride advanceSimulation.
setInterval(() => advanceEcology(Date.now()), ECOLOGY_EVAL_INTERVAL_MS);

function shutdown(): void {
  checkpointSimulation();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
