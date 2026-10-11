# Your harness

This file is yours, and it arrives empty on purpose. The rules you hold the
agent to are part of what gets marked, so they should be rules you decided on.

Nothing about the template is recorded here. What the repo ships is explained
where it lives --- `fly.toml`, the `Dockerfile`, the CI workflow and
`spec/README.md` each say what they fix --- and the course website publishes the
[final project brief](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/assessments/final-project/).
What the agent needs to carry from any of it is your call.

## This project: a persistent insect colony

Long-term concept: a persistent multiplayer insect colony — queen, workers,
territory, evolution, predators, multiple worlds. Each crit is a deliberately
thin slice on top of the last, not a rewrite. Crit 8's slice: one world, one
colony, gather, reproduce, SQLite persistence.

- **Crit 9: realtime is in scope.** A WebSocket server attaches to the same
  `http.Server` Express already creates, at path `/ws`. Every colony mutation
  (`gather`, `reproduce`) broadcasts the resulting state — the same JSON shape
  `GET /api/state` returns — as a text frame to every open connection, so a
  second tab sees it within about a second with no reload. This exact contract
  is what `spec/realtime.test.ts` checks; don't change the message shape
  without updating it there too.
- **Concurrent mutations are serialized by the request-handling thread, not
  by a lock.** Every `better-sqlite3` call in `actions.ts` is synchronous, and
  no action function `await`s between reading colony state and writing it, so
  Express can never interleave two mutations against the one global colony —
  one request's effects fully land before the next request's logic runs.
  Verified empirically: two simultaneous `POST /api/reproduce` calls racing
  for the same protein always produce exactly one success and one rejection,
  never a double-spend (`spec/realtime.test.ts`). This is why nothing here
  needs an explicit lock today. Keep it true: never add an `await` between a
  colony-state read and its matching write inside an action, and never move
  the server to multiple processes or worker threads without first replacing
  this invariant with a real one.
- **"Good" means consequential, not just coexisting.** `README.md`'s
  definition of good says multiplayer should change the shared world, not
  just put two people's cursors in the same room. Keep that in mind once
  Crit 9 adds other players: prefer state shaped so one player's actions are
  visible to another (one colony, one set of resource nodes) over anything
  that quietly partitions the world per visitor.
- **The server is the sole source of truth.** Every gather/reproduce outcome
  is computed server-side; the client only ever renders what `GET
  /api/state` or a `/ws` push returns, never a locally-computed guess or a
  merge of the two. This is what kept adding realtime additive instead of a
  rewrite.
- **Everything the "still there on reload" promise depends on lives in
  SQLite**, not server memory and not the browser. If it matters after a
  restart, it's a column.
- **One global colony/world for now.** No accounts, no per-visitor identity.
  Don't add auth prematurely — that's a Crit 9+ concern tied to multiplayer.
- **No frontend framework.** Plain TypeScript + DOM, bundled with esbuild.
- **Balance constants** (gather yield, reproduce cost, world size) live in
  `src/server/balance.ts`, never as inline literals — they get tuned.
- **`node:24-slim`, not `-alpine`**, in the Dockerfile. `better-sqlite3`'s
  prebuilt binaries have solid glibc coverage; musl often forces a
  from-source compile. Don't switch base images without re-checking this.
- **The server runs straight from `.ts` source** (Node's native type
  stripping — see `tsconfig.json`'s comments). Only the client needs a
  build step (`pnpm build:client`, esbuild). Don't add a server build step
  or a `dist/server/` output; `CMD` runs `src/server/index.ts` directly.

## Stage 1: continuous world, typed resources (post-Crit-9 game direction)

Crit 8/9 shipped a 10x10 grid with one resource type ("food") and instant,
non-spatial gather/reproduce. The project is moving toward an RTS-like
persistent colony game, staged deliberately rather than rewritten in one
pass. Stage 1 only replaces the *world and data model*: a continuous
~3000x3000 world, three real resource types (`sugar`, `protein`, `biomass`)
as rows in `resource_nodes` with their own `amount`/`max_amount`, and a
`colony_resources` ledger keyed by type instead of one flat `protein`
column. No movement, simulation tick, selection box, or carry/deposit
economy yet — those are later stages.

- **Worker commands are never persisted.** A worker's command (idle/move/
  gather, added in a later stage) belongs only to in-memory simulation
  state, never a SQLite column. In-flight commands are not meant to survive
  a restart — only position (and, once a later stage adds it, carrying) is
  durable. Don't add `command_type`/`command_target_*` columns to `workers`
  without first revisiting this decision explicitly.
- **`gather()` is still transitional.** `actions.ts`'s `gather()` is the
  same instant, non-spatial Crit 8/9 RPC — it just now credits whichever
  `colony_resources` bucket matches the clicked node's type instead of
  always incrementing a single `protein` column. It doesn't move the
  worker, claim the node, or touch the node's `amount`. A later stage
  replaces this with real travel + claim + carry + deposit; don't read
  more into today's `gather()` than "the old mechanic, type-aware."
- **Seeding is deterministic, not random.** World size, starting worker
  offsets, and every resource node's position/type/amount are fixed
  constants in `balance.ts`, not randomised — a fresh seed is reproducible,
  and so is a test run.
- **The world renderer is Canvas 2D, not DOM-per-entity.** `public/
  index.html` hosts one `<canvas>` for the queen/workers/resource nodes;
  ordinary HTML still handles counters, the reproduce button, and
  `/readme/`. Hit-testing (click-to-select, click-to-gather) happens in
  world coordinates via the camera transform in `main.ts`, not per-entity
  DOM listeners.
- **Camera, no zoom.** `main.ts` keeps one `{ x, y }` camera panned by
  WASD/arrow keys and mouse drag, clamped to the world bounds. Zoom is
  explicitly deferred; don't add it without a specific reason to.
- **Rendering snaps to the latest known state.** No client-side
  interpolation between updates. If a future stage adds movement and the
  resulting snap feels too choppy, interpolation is a deliberate separate
  rendering change, not something to fold in quietly alongside it.
- **Deployed-DB migration is a deliberate drop, not an ALTER TABLE.**
  `db.ts` detects the pre-Stage-1 schema (a `colonies` table with no
  `world_id` column) and drops `colonies`/`workers`/`resource_nodes` before
  recreating and reseeding them. The Crit 8/9 demo colony's protein/worker
  count is not preserved — it's throwaway demo state, not user data, and
  wasn't worth an ALTER TABLE migration. This is a one-time transition;
  don't repeat this drop-and-reseed pattern for later schema changes
  without the same justification.

## Stage 1b: authoritative simulation, worker movement

Stage 1 had no movement — positions were static rows. Stage 1b adds a real
tick loop (`src/server/simulation.ts`) that moves workers continuously
toward a commanded target. This changes where "the current state" lives.

- **In-memory simulation state is authoritative; SQLite is a checkpoint,
  not a live store.** `simulation.ts` holds the one `Map` of worker
  positions/commands the server trusts. `GET /api/state`, every broadcast,
  and `reproduce()`'s result must all read worker positions through
  `getWorkersForColony()` — never with a direct `SELECT ... FROM workers`
  — or they'll show a stale, last-checkpointed position instead of where
  the worker actually is mid-tick. The `workers` table only exists so a
  restart has somewhere to resume from.
- **Checkpoint, don't write every tick.** Writing SQLite at `tickHz` would
  turn continuous movement into a continuous write load for no benefit —
  nothing reads `workers.x`/`y` live. `checkpointSimulation()` flushes all
  positions in one transaction on a timer (`SIMULATION.checkpointIntervalMs`)
  and again on `SIGTERM`/`SIGINT`, so a graceful restart loses at most one
  interval's movement. In-flight commands are never part of the checkpoint:
  `loadSimulation()` always brings every worker back `idle`, deliberately —
  a command is ephemeral intent, not durable state (same reasoning as
  Stage 1's note on worker commands above, now exercised for real).
- **Tick and broadcast run at different rates on purpose.**
  `SIMULATION.tickHz` (10) advances positions; `SIMULATION.broadcastHz` (5)
  is how often clients get a frame. Ticking faster than broadcasting is what
  makes movement smooth in memory without doubling network chatter — don't
  collapse them to one rate without a reason. The broadcast loop also skips
  sending when `consumeDirty()` reports nothing moved since the last frame,
  so an idle world doesn't push identical state forever; any action's own
  HTTP response still broadcasts unconditionally, as before.
- **Reproduce must keep the sim cache and SQLite in lockstep.**
  `actions.ts`'s `reproduce()` inserts the new worker row and then calls
  `registerWorker()` synchronously, in the same call stack, immediately
  after the transaction commits — no `await` in between. Skipping this
  would leave a newly-hatched worker invisible to `getWorkersForColony()`
  until the next full `loadSimulation()`, i.e. the next restart. This is
  also why `advanceSimulation()`/`issueMoveCommand()`/`checkpointSimulation()`
  stay fully synchronous: an `await` anywhere in that path would let an
  HTTP handler's mutation interleave with a tick, which is exactly the
  invariant Crit 9's concurrency note above protects.
- **Tests get simulation time without sleeping, and without a debug
  endpoint.** `spec/simulation.test.ts` imports `simulation.ts` directly
  into the Vitest process — the one exception to the rest of `spec/`, which
  tests the app strictly as a black box over HTTP against a separately
  running process. It points `DB_PATH` at a throwaway file
  (`./.data/colony.sim-test.db`, gitignored) via `process.env.DB_PATH`
  (see `db.ts`), so it shares no state with the dev DB, the deployed
  volume, or the HTTP-tested app, and can call `advanceSimulation(dt)`
  with whatever `dt` it likes instead of waiting on a real timer. This was
  chosen over adding a `/api/debug/tick` style endpoint, which would be
  one more production surface to secure for a need that's purely a test
  harness. `spec/realtime.test.ts` still uses real (short) wall-clock waits
  for its one movement-broadcast test, since that test's job is to confirm
  the production timer loop actually fires, not to check the movement math.

## Stage 1c: gather is real travel, not an instant RPC

`actions.ts`'s transitional `gather()` is gone. Gathering is now a command
like move, issued via `POST /api/command/gather { workerIds, resourceId }`
and resolved entirely inside `simulation.ts`'s tick loop — there is no
synchronous "gather now" code path left anywhere.

- **One movement implementation, not two.** A `gather` command steps toward
  its target with the exact same per-tick code a `move` command uses; the
  only differences are the arrival distance (`GATHER_RANGE` instead of
  exactly zero) and what happens on arrival (`attemptGatherClaim` instead
  of just going idle). Don't fork a separate "gather movement" function —
  if gather ever needs to move differently from move, that's a deliberate
  design change to call out, not something to drift into.
- **Issuing a gather command never credits anything.** `issueGatherCommand`
  only records the worker's intent and the resource's position at that
  instant (`lastKnownX`/`lastKnownY`). The only place a claim is ever
  attempted is `attemptGatherClaim`, called from `advanceSimulation` on
  arrival. `spec/colony.test.ts` and `spec/realtime.test.ts` assert the
  negative explicitly (no credit in the command's own HTTP response) as
  well as the eventual credit.
- **A claim re-reads the node, it never trusts a cached amount.** Another
  worker's claim earlier in the very same tick may have just reduced or
  deleted the row `attemptGatherClaim` is about to act on — see the
  contested-claim test (E) in `spec/simulation.test.ts`. A claim is capped
  at whatever's actually left, and a node is deleted once its amount hits
  zero (`amount: null` nodes, like sugar, never deplete).
- **A resource that vanishes before a worker arrives demotes the command to
  a plain move toward its last-known position.** `advanceSimulation` checks
  `findResourceNode` once per worker per tick, before moving it; if the
  targeted row is gone, the command becomes `{ type: "move", ... }` at the
  same coordinates and no further claim is attempted when it gets there —
  see test G. This is what keeps a worker from getting stuck chasing a node
  another worker just finished off.
- **Processing order inside a tick is deterministic and load-bearing.**
  `advanceSimulation` iterates the `workers` Map in insertion order, and
  `loadSimulation` inserts rows `ORDER BY id` — so "whoever's processed
  first wins a contested claim" is a real, reproducible rule, not a race.
  Don't change the Map to something unordered, and don't parallelize this
  loop.
- **`spec/simulation.test.ts`'s gather tests register throwaway synthetic
  workers** (ids well above the 3 seeded ones, via `registerWorker`)
  positioned exactly on top of whichever node they're exercising, so a
  claim can be forced in a single tick instead of waiting out real travel
  time. These workers have no `workers` SQL row — harmless, since nothing
  but `checkpointSimulation()` reads that table and these tests never call
  it. `spec/colony.test.ts` and `spec/realtime.test.ts`, being black-box
  HTTP tests, instead pick the *nearest* node of a type to a real seeded
  worker (`closestNode`) to keep real travel time bounded, and poll
  `GET /api/state` / wait on WebSocket frames for the resulting credit
  rather than asserting on an immediate response.

## Stage 2: RTS selection and group commands

Multi-selection is a purely client-side concept — `selectedWorkerIds` lives
only in `src/client/main.ts`'s browser state, is never sent to the server
except as the `workerIds` array on a command, and is never synced between
browser tabs or persisted anywhere. Two tabs can have entirely different
selections of the same colony's workers at the same time; that's expected,
not a bug (see "multi-user semantics" below).

- **Batch commands never let one bad id block the rest (brief 8B).**
  `POST /api/command/move` and `/gather` used to loop over `workerIds` and
  `return` on the first per-id error, so one bad id blocked every id after
  it in the array. `runBatchCommand` in `index.ts` now attempts every id
  unconditionally and collects failures into `errors: { [workerId]: reason
  }`. The request only 400s if *every* id failed (preserving the old
  all-invalid behaviour); if at least one succeeded, the response is `200`
  with the resulting state plus `errors` naming exactly which ids didn't go
  through. Whole-request validation (shape, missing coordinates/resourceId)
  still 400s before touching any worker — those failures apply identically
  regardless of which ids are valid, so there's nothing per-id to report.
- **Selection replaces, it doesn't toggle or add.** Clicking a worker sets
  the selection to exactly that one worker. The only way to select more than
  one is a left-drag box. There's no shift-click-to-add and no click-to-
  deselect — simpler, and the brief doesn't ask for either.
- **Control scheme: button, not modifier, picks the gesture.** Left button
  drags a selection box (or, without crossing the drag threshold, clicks);
  middle or right button drags to pan. One button always means one thing, so
  there's never a question of what a given drag does. `canvas`'s
  `contextmenu` is suppressed so right-drag-to-pan doesn't pop the browser
  menu afterward. This is stated explicitly in `public/index.html`'s hint
  text — the brief's "document the controls somewhere visible" requirement.
- **The selection box is computed in world space, not screen space.**
  `screenToWorld` runs at drag-start and on every `mousemove`, and the box's
  two corners are only converted back to screen coordinates for drawing.
  WASD panning runs independently every animation frame regardless of
  mouse state, so a world-space box is what keeps the box correct if the
  camera pans *during* a drag, not just before one. Selection is by centre
  point only (`worker.x/y` inside the box's bounds) — no partial-circle
  intersection test.
- **Commands never clear the selection.** Issuing a move or gather leaves
  `selectedWorkerIds` as-is, so a group can be issued several commands in a
  row, or stay selected to watch them arrive.
- **Multi-user semantics: last command wins, per worker.** Two browser tabs
  (or two players) can each select and command the same worker; whichever
  command's HTTP request reaches `issueMoveCommand`/`issueGatherCommand`
  last simply overwrites that worker's `command` field (see test I in
  `spec/simulation.test.ts`, which exercises one worker's command being
  replaced while a sibling's is untouched). There's no ownership, locking,
  or conflict resolution — the server is already the sole authority over
  worker state (Stage 1b), so "last write wins" falls out of that for free,
  the same way `reproduce`'s single-process guarantee does.
- **Overlap/stacking on arrival is deliberately out of scope.** Several
  workers can occupy the same point (e.g. a group gather command all
  converging on one node's centre) — Stage 2 has no collision or spacing
  logic, per the brief's explicit exclusions. Stage 3 may revisit this.
