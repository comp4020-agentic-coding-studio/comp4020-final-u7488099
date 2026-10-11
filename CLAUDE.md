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

## Stage 3: loose swarm movement

Stage 2 left workers free to stack exactly on top of one another. Stage 3
adds a loose destination area for group moves plus continuous worker-worker
separation, both computed entirely in `simulation.ts` — the client only
gained a `WORKER_RADIUS` import so its circles match the server's idea of a
worker's footprint.

- **`MIN_SEPARATION` is exactly `2 * WORKER_RADIUS`, and the trigger is a
  strict `<`, not `<=`.** That's the natural "circles just touching"
  threshold, and it's also what keeps the pre-existing `"arrival"` test in
  `spec/simulation.test.ts` passing unmodified — that test's fixed-seed
  geometry happens to place a worker exactly `MIN_SEPARATION` units from its
  target, and a strict `<` means separation never fires exactly at the
  boundary. If `MIN_SEPARATION` or the comparison operator ever changes,
  re-check that test's geometry by hand before trusting it.
- **Separation runs for every worker, every tick, idle or not, from one
  pre-tick snapshot.** `advanceSimulation` builds a uniform spatial grid
  (cell size `MIN_SEPARATION`) once per tick from wherever every worker
  started that tick (Jacobi-style, not Gauss-Seidel) — so the result doesn't
  depend on Map iteration order, only `separationDelta`'s own math does. A
  worker queries its own cell plus its 8 neighbours, never the whole worker
  set — this is the "no permanent O(n²) scan" requirement; it's a plain
  `Map<string, SimWorker[]>` rebuilt from scratch each tick, not a
  persisted structure, and not exported outside `simulation.ts`.
- **Separation is additive, not a replacement for the attraction step.** An
  idle worker gets the separation delta applied directly; a moving/
  gathering worker gets its existing toward-target step plus the separation
  delta, then the combined result is clamped into world bounds. The
  separation vector itself is also capped at `WORKER_SPEED * dt` per tick,
  so it can slow or delay progress but can never out-run or reverse it
  outright, and it can never push a worker outside `[0,width]x[0,height]`.
- **Arrival is decided from the attraction-only step, before separation is
  added — not from the combined post-movement position.** A worker's target
  is frequently exactly where a neighbour stands (a shared gather node, the
  spot another worker just vacated), so separation there often points
  straight against attraction; letting it participate on an arriving tick
  could cancel or reverse the final approach step and stall a claim
  indefinitely. The sequence per tick is: compute the attraction-only
  landing position; if that alone is within `arrivalRange`, snap to it,
  claim, go idle, and skip separation entirely for that tick; only
  otherwise is separation added on top. This was a real bug found during
  Stage 3 verification, not a hypothetical: the original "add both, then
  check" ordering broke two pre-existing contested-claim tests (workers 5
  units apart) and a new Stage 3 gathering-regression test, all for the same
  reason. Separation can still delay an arrival on a tick that doesn't reach
  it, but never blocks one that does, and the result is still clamped into
  world bounds either way.
- **A second, independent bug surfaced only against the real server, not the
  fixed-`dt` unit tests: a worker could get stuck forever a hair outside
  `arrivalRange`.** Both arrival checks compare a `Math.hypot`-derived
  distance against `arrivalRange`; a tick's step is deliberately sized to
  close the remaining distance to exactly `arrivalRange`, but `hypot`'s
  rounding can land a sliver *above* it instead of on or under it. Observed
  live: a worker parked at `dist = 30.00000000000002` against
  `GATHER_RANGE = 30`, where the resulting step (~2e-14) was smaller than a
  coordinate of that magnitude's own floating-point precision and so never
  actually moved it — permanently stuck outside range, claim never
  attempted, `protein` stuck at 0. Fixed with a fixed `ARRIVAL_EPSILON =
  1e-6` tolerance added to both arrival comparisons in `advanceSimulation`.
  This is a pre-existing class of bug (the exact-equality arrival check
  predates Stage 3), just one Stage 3's exact-landing step math happened to
  expose and that the black-box `colony.test.ts`/`realtime.test.ts` suites
  (real geometry, real timers) hit where the unit tests' round-number
  geometry never did.
- **`computeGroupDestinations(workerIds, centerX, centerY)` turns one
  clicked point into one destination per worker.** A single-worker array
  maps to the exact, unclamped centre — no offset at all, so solo moves
  (and their existing out-of-bounds rejection in `issueMoveCommand`) are
  untouched. For more than one worker, ids are sorted ascending for a
  deterministic index and placed on a golden-angle phyllotaxis spiral
  around the centre (`radius = GROUP_DESTINATION_SPACING * sqrt(i)`,
  `angle = i * GOLDEN_ANGLE`) — chosen over a grid/rows layout specifically
  because the brief asked for an organic-looking spread, and a spiral never
  produces the same point twice for two different indices. Each point is
  then clamped into world bounds. The function is pure (ids + centre only,
  no worker lookup), so it's trivially unit-testable and so that a group's
  on-screen spread doesn't depend on what the workers were doing before the
  command.
- **Gather commands are never offset.** Only `POST /api/command/move` calls
  `computeGroupDestinations`; `POST /api/command/gather` still passes every
  worker straight at `issueGatherCommand(workerId, resourceId)`, so a group
  gather always targets the resource's real centre. `GATHER_RANGE` (30) is
  larger than `MIN_SEPARATION` (20) on purpose — several workers can be
  within claim range of the same node while still keeping separation
  distance from each other, so claiming (Stage 1c's travel/claim/deplete/
  demote semantics) is structurally unaffected by separation.
- **Redirecting a group needs no special-case code.** A redirect is just
  another `POST /api/command/move` with a new centre; a fresh call to
  `computeGroupDestinations` naturally produces fresh offsets, so Stage 2's
  "new command replaces the old, per worker" semantics fall out for free.

## Stage 4: carry, return, deposit economy

Every stage through Stage 3 credited the colony the instant a worker arrived
at a resource. That made distance free — there was never a reason not to
send a worker to the farthest node on the map. Stage 4 splits "gather" into
`idle → gather (travel, claim payload into carrying) → return (auto, travel
home) → deposit (credit colony, clear carrying) → idle`, so the trip back
is where distance actually costs something.

- **`carrying` is economic state, not a command — it gets its own
  durability discipline.** A worker's `command` is still never persisted
  (Stage 1b/1's rule, unchanged): it resets to idle on every reload. But
  `carrying` is real, uncredited value a worker is holding, and it survives
  a restart via two new nullable `workers` columns (`carrying_type`,
  `carrying_amount`). On `loadSimulation()`, a worker with non-null carrying
  comes back with `command: {type:"return"}` instead of idle — a restart
  must not stand between a worker and the payload it's already holding.
- **Claim and deposit are each one `db.transaction()`, because each pairs
  an economic change with a durability change that must never split.**
  `attemptGatherClaim` combines the node's depletion/deletion with writing
  `carrying_type`/`carrying_amount` onto the worker's row — otherwise a
  crash between "node decremented" and "worker's payload persisted" would
  destroy resources that came from nowhere and went nowhere.
  `attemptDeposit` combines crediting `colony_resources` with clearing
  those same two columns back to NULL — otherwise a crash between "colony
  credited" and "carrying cleared" would mean a reload resurrects the
  worker still holding a payload it already turned in, and it deposits
  again. Both transactions are the only two places economic ownership of a
  resource actually changes hands; nowhere else needs this discipline.
- **A claim and the deposit it triggers never resolve in the same tick,
  even if the claim happens within `DEPOSIT_RANGE` of the queen.**
  `resolveArrival` only ever converts `gather → return` on a claim — it
  doesn't re-check arrival against the new `return` target in the same
  pass. This mirrors the pre-existing `gather → move` demotion (Stage 1c),
  which has the same one-conversion-per-tick shape. A test asserting
  deposit completion needs at least two `advanceSimulation` ticks even for
  a worker claiming right next to the nest.
- **The busy-worker gate checks `worker.carrying`, not
  `command.type === "return"`.** They're always set together in practice,
  but carrying is the thing that's actually consequential — it's the value
  a stray move/gather command must not be allowed to silently abandon.
  `issueMoveCommand`/`issueGatherCommand` return `"worker is busy returning
  resources"` for a carrying worker, before any other validation.
  `runBatchCommand` (Stage 2) needed no changes: it already collects
  per-id errors without failing a whole batch over one busy id, so a batch
  move with one carrying worker and one free worker still moves the free
  one and names the busy one in `errors`.
- **The nest-position cache assumes `colonies.queen_x/y` never changes
  after seeding.** `nestPositions` is populated once in `loadSimulation()`
  and never invalidated. If a later stage ever lets a colony's queen move
  or allows multiple colonies with different nests, this cache needs to be
  rebuilt or keyed more carefully — right now it's safe only because
  nothing ever updates those two columns.
- **`checkpointSimulation()` deliberately does not flush carrying.**
  Position is checkpointed periodically because nothing else makes it
  durable; carrying is already made durable the instant it changes, inside
  claim's and deposit's own transactions. Don't "fix" this by adding
  carrying to the periodic checkpoint — that would just be a second, looser
  writer of the same columns.
- **Reproduction needed zero code changes.** `actions.ts`'s `reproduce()`
  already reads `colony_resources` directly, never a worker's carrying —
  so carried-but-undeposited protein was never spendable, purely because of
  where the read happens, not because of new logic added for this stage.
- **Test isolation seam: `resetForTests()` plus a `beforeEach`, not test
  ordering.** `spec/simulation.test.ts` had relied on each test picking a
  synthetic id range or an as-yet-untouched seeded node to avoid colliding
  with what earlier tests had already claimed or depleted — workable at 41
  tests, but not something to keep stacking tests onto. `db.ts` now exports
  `resetForTests()` (wipe every table, reseed via the existing
  `seedIfEmpty()`), and `simulation.test.ts` calls it plus
  `sim.loadSimulation()` in a top-level `beforeEach`. This is safe because
  none of the seeded tables use `AUTOINCREMENT`, so a reset always
  reproduces the exact same ids (world=1, colony=1, workers=1/2/3,
  resource_nodes=1..12) — the handful of `const colony = …` /
  `const world = …` lookups captured once at module load time stay valid
  across every reset. Per-test synthetic id ranges are kept where they
  already existed (harmless extra safety) but are no longer load-bearing.
  **Caveat that cost real debugging time while writing this stage's
  reload-persistence tests:** a synthetic worker registered via
  `sim.registerWorker()` only exists in the in-memory Map — it never gets a
  `workers` SQL row. `loadSimulation()` clears the Map and repopulates it
  strictly from that table, so a synthetic worker is silently erased by any
  test that calls `loadSimulation()`. Tests that need a worker to survive a
  reload use one of the 3 real seeded workers (via `getWorkersForColony`)
  and, when they need it positioned on a node or near the queen for fast
  test setup, call `sim.registerWorker({id: <that seeded id>, ...})` purely
  as an in-memory teleport — its SQL row (and thus `loadSimulation()`'s
  view of it) is unaffected by that in-memory overwrite.
- **HTTP-level protein tests got slower and their helper got less naive.**
  A full claim→return→deposit round trip for protein is roughly 2x the old
  single-leg travel time, and a worker that's already carrying/returning
  now rejects a re-issued gather command. `gatherProteinUntil` in both
  `spec/colony.test.ts` and `spec/realtime.test.ts` now re-issues gather to
  every currently-idle (`!carrying`) worker each poll cycle instead of
  blindly re-posting to one fixed worker id that might now be busy; the
  tests that call it with a target of 50 (one full `REPRODUCE_COST`) carry
  an explicit longer `it()` timeout rather than raising the global one.

## Stage 5: living world — renewable resources + aphids

Stage 1–4 built a world where nothing happens unless a player issues a
command. Stage 5 is explicitly not the combat stage — it's the one that
makes the world visibly continue without input, via exactly two pieces of
autonomous behaviour: renewable sugar/biomass regeneration, and a first
neutral, non-interactable creature (the aphid) that wanders on its own.

- **Sugar nodes are now finite + renewable, not genuinely infinite.** Every
  seeded sugar node used to be `amount: null, maxAmount: null`. "Renewable"
  is meaningless for a node that never depletes, so Stage 5 changes seeded
  sugar to `amount: SUGAR_NODE_MAX_AMOUNT, maxAmount: SUGAR_NODE_MAX_AMOUNT`
  and ships `migrateSugarNodesFinite()` in `db.ts` to convert an
  already-deployed world's sugar rows the same way on next boot. True
  infinite nodes (`amount: null`) are still fully supported — Stage 4's
  deposit-range tests still insert their own explicit `amount: null` sugar
  node and are untouched by anything in this stage, which is the proof that
  infinite nodes keep behaving exactly as before.
- **Renewability has exactly one source of truth: `RESOURCE_REGEN_RATES` in
  `balance.ts`.** A resource type's presence as a key there drives both the
  regen tick (`advanceResourceRegen`) and `attemptGatherClaim`'s
  no-delete-at-zero branch. Sugar and biomass are renewable; protein has no
  entry, so it's unaffected and keeps its original delete-on-depletion
  behaviour unchanged.
- **A renewable node can reach `amount === 0` without its row being
  deleted — only non-renewable types are deleted on depletion.**
  `attemptGatherClaim` floors a renewable node's amount at 0 and leaves the
  row in place; a non-renewable node (protein) is still `DELETE`d the
  moment its amount hits zero, exactly as before Stage 5.
- **Regen is a direct SQL `UPDATE` per tick, with no in-memory cache for
  resource nodes — same as every claim before this stage.** Resource nodes
  have never lived in a `Map`; `advanceResourceRegen` keeps that precedent
  rather than introducing a second kind of node state. It's not wrapped in
  the same transaction as a claim, so a crash mid-tick can lose at most one
  tick's worth of regen on one node — acceptable per the brief, since regen
  doesn't need to be crash-perfect.
- **Renewable resources regenerate only while the simulation is actively
  ticking — there is no offline/elapsed-time catch-up on boot.** A server
  that's down for an hour does not credit an hour of regen on `loadSimulation()`;
  regen only ever advances inside `advanceSimulation(dt)`, called from the
  live 10Hz tick. This is a deliberate exclusion per the brief, not an
  oversight — don't add boot-time catch-up without revisiting this.
- **Creatures follow the worker pattern, not the resource-node pattern.**
  Aphid positions change continuously at 10Hz exactly like worker
  positions, so they get their own in-memory `creatures` Map in
  `simulation.ts` — loaded in `loadSimulation()`, advanced every tick in
  `advanceCreatures(dt)`, flushed to SQLite on the existing periodic
  checkpoint alongside worker positions, never written to SQL every tick.
- **Creature *existence* (id, species, position) is durable; creature
  *command* (idle/wander, remaining time, target) is ephemeral — same
  durability split Stage 1b/4 already draws for workers.** The `creatures`
  table and periodic checkpoint persist id/species/x/y across a restart.
  `loadSimulation()` always brings every creature back into a brief `idle`
  state with a fresh deterministic RNG seeded from its id — the in-flight
  wander target does not survive a restart, deliberately, per the brief.
  Wandering resumes on its own within `APHID_IDLE_MAX` seconds either way,
  so a restart reads as "it paused briefly," not as a frozen aphid.
- **Aphid wander destinations are deterministic per creature, not
  `Math.random()`-driven.** Each creature carries its own xorshift32 state
  seeded from `(id * 0x9E3779B1) >>> 0`, so a given creature's sequence of
  wander targets is reproducible across a process restart for a fixed tick
  sequence — chosen specifically so `spec/simulation.test.ts` can assert on
  movement without flaking.
- **Aphids are neutral and non-interactable this stage — no selection, no
  commands, no HP, no collision/separation with workers or each other, no
  UI panel.** The client renders them as a simple diamond marker (distinct
  shape and colour from every circular marker) but never considers them in
  `hitTest()`/`onCanvasClick()`. The existing worker spatial grid
  (Stage 3's separation system) is not extended to include aphids — nothing
  in Stage 5 needs it, and the brief explicitly says it doesn't have to be.
- **Creature state rides the existing realtime channel — there is no
  separate creature WebSocket protocol.** `creatures: [{id, species, x, y}]`
  is just one more field on the same `ColonyState` object `GET /api/state`
  and every broadcast frame already return. Aphid movement sets `dirty =
  true` in `advanceCreatures` exactly like worker movement does, so the
  existing dirty-gated 5Hz broadcast loop picks it up for free.
- **Resource sources vs. resource items: deliberately not split this
  stage.** The brief asks whether Stage 5 is the point to separate
  renewable "sources" (regenerating, tied to a fixed map location — what
  `resource_nodes` already models) from ephemeral "items" (material
  instantiated by an event, e.g. a future aphid carcass). There is no
  concrete item concept to build yet — no carcasses, no drops, nothing
  Stage 5 creates on a creature's death, because creatures can't die yet.
  Splitting the schema now would mean guessing at Stage 6's carcass shape
  with no second real case to validate the design against, so this stays
  one table. Revisit this the moment Stage 6 actually introduces something
  that fits "item" better than "source."

## Stage 6: hunting, combat, and carcasses

Stage 5 made aphids move on their own but left them inert — nothing a
player did touched them. Stage 6 connects creature combat to the existing
spatial/carrying economy: a player selects worker(s), clicks an aphid, the
worker(s) chase and attack it on a range+cooldown, the aphid dies when its
health reaches zero and leaves behind a finite carcass, and the player must
then explicitly command a gather on that carcass exactly like any other
resource node. There is still no predation of workers, no worker HP, no
aphid fleeing/retaliation, no auto-gather after a kill, and no respawning —
those remain explicitly out of scope.

- **Combat is fully server-authoritative, same as every other mutation
  since Stage 1b.** Damage, cooldown, and death are computed only inside
  `advanceSimulation`'s per-tick loop; the client never simulates a hit or
  a death locally — it only renders whatever the latest broadcast or
  `GET /api/state` response says. There is no client-side prediction of
  combat outcomes, matching the existing "snap to latest known state"
  rendering convention.
- **Attack is an ephemeral `WorkerCommand`, in the same category as
  move/gather/return.** `{ type: "attack", creatureId, cooldownRemaining }`
  is never written to the `workers` table and always resets to `idle` on
  `loadSimulation()` — a restart never resumes an attack, by design. Unlike
  `gather`'s `lastKnownX/Y`, an attack command carries no cached position:
  every tick re-reads the creature's live position straight from the
  `creatures` Map, so a worker chases where the target actually is, not
  where it was when the command was issued. If the creature no longer
  exists (killed, or removed for any other reason) the worker degrades
  straight to idle — the same safe-degrade shape `gather` already uses when
  its target resource vanishes (Stage 1c).
- **`issueAttackCommand` follows the exact single-id convention
  `issueMoveCommand`/`issueGatherCommand` already use**, so it slots into
  `index.ts`'s existing `runBatchCommand` helper with zero new batch-error
  plumbing: `POST /api/command/attack { workerIds, creatureId }` attempts
  every id unconditionally, 400s only if every id fails, and otherwise
  returns 200 with per-id `errors` for whichever ids didn't go through
  (`"no such worker"`, `"no such creature"`, or — reusing Stage 4's exact
  wording — `"worker is busy returning resources"` for a carrying worker).
  A carrying worker cannot be redirected into combat, same as it can't be
  redirected into a new move/gather.
- **Creature `health`/`maxHealth` are durable, written synchronously to
  SQLite on every hit — not batched into the periodic checkpoint.** This
  mirrors Stage 4's precedent that `carrying` is made durable the instant
  it changes inside its own transaction, rather than waiting on the
  position checkpoint timer. The columns are nullable (`creatures.health`,
  `creatures.max_health`), added via a guarded `ALTER TABLE`
  (`migrateCreatureHealth()`, mirroring `migrateWorkersCarrying()`'s guard
  pattern) and immediately backfilled per species via a `SPECIES_MAX_HEALTH`
  map (`backfillCreatureHealth()`) so "health IS NULL" never persists past
  one boot, and a species added to that map later also backfills
  automatically. Health is species-keyed rather than hardcoded so a future
  species needs only a new map entry, not a schema change.
- **A creature's death and its carcass's creation happen in one SQLite
  transaction.** `killCreature` deletes the `creatures` row and inserts the
  carcass `resource_nodes` row inside a single `db.transaction()` — no code
  path can produce an orphaned creature or a missing/duplicate carcass, even
  across a crash mid-kill. In-memory state (the `creatures` Map, and every
  attacking worker's command) is only updated after the transaction commits,
  keeping the in-memory cache synced to the committed result exactly like
  every other durable mutation in this codebase.
- **`resource_nodes.kind` (`'source' | 'item'`) distinguishes a renewable,
  fixed-location producer from a finite dropped item.** This was chosen
  over splitting `resource_nodes` into two tables: it's the smallest clean
  change that gives an explicit, queryable concept of "this row is a
  dropped/finite item, not a renewable source," without a speculative
  schema rewrite before a second item type exists to validate the design
  against. The column defaults to `'source'`, so every pre-Stage-6 row
  (sugar, biomass, the original finite protein nodes) is correctly
  classified with no backfill `UPDATE` needed — only the guarded `ALTER
  TABLE` itself. A carcass is inserted as `kind: 'item'`, `resourceType:
  'protein'`, `amount = maxAmount = APHID_PROTEIN_VALUE`. Because protein
  was already absent from `RESOURCE_REGEN_RATES` (Stage 5), a carcass
  automatically inherits correct non-regenerating, delete-at-zero behaviour
  from `attemptGatherClaim`'s existing renewable/non-renewable branch —
  **no change was needed there at all.** Gather/carry/return/deposit in
  `simulation.ts` needed zero changes either, since that machinery has only
  ever operated on `resourceType` + `amount`/`maxAmount`, never on how a row
  was created; multiple workers can harvest a carcass via the same
  contested-claim semantics any other node already has. The client uses
  `kind === 'item'` only to draw a visually distinct carcass marker.
- **Chase closes to `WORKER_ATTACK_RANGE`, never past it, and the step is
  capped so a fast worker can't overshoot the target on a single tick** —
  the same `ARRIVAL_EPSILON`-guarded step-capping idiom Stage 3's move/
  gather arrival logic already uses. `WORKER_ATTACK_RANGE` (30) is chosen
  comfortably above `MIN_SEPARATION` (20, i.e. `2 * WORKER_RADIUS`) so the
  separation force computed every tick (Stage 3) can never prevent a worker
  from reaching attack range — same scale reasoning as `GATHER_RANGE`.
  Separation is still applied on every attack tick, including while in
  range, so several workers attacking the same creature keep spacing from
  each other instead of stacking.
- **Cooldown is a plain per-command countdown, decremented every tick
  regardless of whether a hit lands.** A freshly issued attack starts at
  `cooldownRemaining: 0`, so it can land a hit the instant it's in range
  rather than being forced to wait out a full cooldown first. Multiple
  workers attacking the same creature each track their own independent
  cooldown, so simultaneous hits from several attackers in the same tick
  are expected and intentional — that's the mechanism by which adding more
  workers to a fight visibly speeds up a kill.
- **On a kill, every worker that was attacking that creature goes idle in
  place.** Nothing auto-gathers the new carcass and nothing auto-retargets
  another creature — the player must explicitly issue a new command for
  both, per the brief. This is enforced inside `killCreature` itself (an
  attacker-idle sweep over every worker whose command still references the
  dead creature's id), not left to each attacking worker's own next-tick
  logic, so it holds even for a worker still mid-chase toward the target
  the instant another attacker's hit kills it.
- **No aphid respawning exists yet.** Killing every aphid in a world
  permanently empties it of prey until a future stage adds respawning —
  acceptable in tests, but production manual verification should kill only
  one or two aphids rather than exterminating the seeded population.


