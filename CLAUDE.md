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

## Crit 10: real multiplayer — one session, one colony, shared world

Every stage through Stage 6 had exactly one colony; "multiplayer" meant
several browser tabs all looking at the same thing. Crit 10 makes that
literal: one anonymous browser session now owns one persistent colony in a
shared world, and the server is the one place that decides who owns what.

- **Authorization model: a session cookie resolves to a colony server-side;
  the client never supplies one.** `sid` (`src/server/sessions.ts`) is an
  opaque `crypto.randomUUID()` token, set `httpOnly`/`sameSite: "lax"` on
  first contact with any `/api` route (`index.ts`'s session middleware,
  scoped to `/api` only — static assets and `/readme/` don't need a colony,
  and never minting one there means a cookie-less crawler never gets a
  throwaway colony). `resolveOrCreateColony()` is the one function every
  request's authority flows through: existing cookie → existing colony
  (`sessions` table lookup); no cookie, or a stale one from a wiped test DB
  → mint a new session and claim/create a colony. No passwords, no
  accounts, no client-supplied id is ever trusted as an identity claim —
  this is the whole point of the crit, and it's why `issueMoveCommand`/
  `issueGatherCommand`/`issueAttackCommand` (`simulation.ts`) all take an
  `ownerColonyId` argument resolved this way, never read from the request
  body, and check `worker.colonyId !== ownerColonyId` before touching
  anything. A worker that exists but belongs to someone else's colony is
  reported as `"no such worker"` — the exact same error a nonexistent id
  gets — so a wrong-owner id can never be used to probe which ids exist
  under another player's colony.
- **The original Crit 8 colony becomes "player one," not a migration
  target.** `seedIfEmpty()`'s colony is unchanged, but as of Crit 10 it
  starts out with no row in the new `sessions` table pointing at it —
  `getUnclaimedColonyId()` (`db.ts`) finds exactly that colony and the very
  first real session to arrive claims it, instead of a brand-new colony
  being minted on top of it. This was chosen over dropping and reseeding
  (Stage 1's precedent for a genuine schema break) because nothing about
  Crit 10 actually requires throwing the existing colony away, and it's
  also what keeps `spec/simulation.test.ts` — which captures
  `colonies LIMIT 1` once at module load and expects it to already exist —
  working unmodified.
- **A spare, unclaimed colony is always kept pre-minted.** Without this, a
  session's own `GET /api/state` response (its `colonies` roster) could
  never include the colony the *next* session is about to claim — that
  colony simply wouldn't exist yet at the moment this session's response is
  serialized, since colonies are claimed/minted lazily on first contact.
  `resolveOrCreateColony()` mints one extra unclaimed colony immediately
  after resolving its own caller's, so the next joiner's eventual colony is
  already a visible part of the shared world the instant this request
  returns. `spec/multiplayer.test.ts`'s "shows both sessions the same
  shared world..." test is exactly what this exists to satisfy — it never
  re-fetches alice's state after bob's colony is created, so for alice's
  *original* response to list bob's colony id, that colony has to already
  exist before bob ever arrives.
- **New colonies spread out on the same golden-angle spiral
  `computeGroupDestinations` already uses for group worker placement**
  (`GOLDEN_ANGLE`, now exported from `balance.ts` instead of a private
  constant in `simulation.ts`, so `db.ts`'s `createColony()` can reuse the
  exact same irrational number rather than a second copy of it), centred on
  the world instead of a click point. Colony index 0 — the very first
  colony any world ever seeds — lands at radius 0, exactly
  `(width/2, height/2)`, the pre-Crit-10 single-colony seed position,
  unchanged.
- **Private economy vs. shared roster: `colonies` on `ColonyState` is
  `{id, queenX, queenY}` only, never a resource ledger.** `state.ts`'s
  `getState(colonyId)` still returns one colony's own full resources and
  workers, same shape as before, plus this new array listing every colony
  in the world. The client (`main.ts`) draws every other colony's queen in
  a visually distinct colour, with no workers or resources rendered for
  them — "the roster is shared, the economy isn't" is enforced by what the
  server ever puts in the payload, not by anything the client chooses not
  to draw.
  **Post-Stage-6b correction:** "no workers... rendered for them" above was
  a real bug, not a deliberate design choice — two colonies standing in the
  same spot couldn't see each other's workers at all. The fix adds
  `otherWorkers` to `ColonyState` (`getWorkersExcludingColony()` in
  `simulation.ts`): every worker NOT belonging to the caller, tagged with
  its public `colonyId`. It's a new field, not a widened `workers`, so
  `workers` still means exactly "my own colony, fully selectable" and
  `hitTest`/`selectWorkersInBox` in `main.ts` needed no new filter — they
  simply never look at `otherWorkers`. Authorization was never the bug and
  is untouched: `issueMoveCommand`/`issueGatherCommand`/`issueAttackCommand`
  already checked `worker.colonyId !== ownerColonyId` against the full
  in-memory worker map, independent of what `getState()` chose to render.
  See `spec/multiplayer.test.ts`'s otherWorkers tests and
  `spec/realtime.test.ts`'s otherWorkers WebSocket test.
- **The WebSocket layer moved from one shared broadcast to one broadcast
  per colony, computed once per tick, not once per client.** Pre-Crit-10,
  `broadcastState()` serialized a single precomputed state once and sent
  the identical string to every client — there was no per-connection
  `getState()` call and no immediate send on connect, so near-simultaneous
  connections always saw a bit-identical first frame (both came from the
  same periodic tick). Now that every connection belongs to a different
  colony, that single shared payload doesn't exist; the WS handshake
  resolves `colonyId` once (`req.headers.cookie`, same session resolution
  as any HTTP request — a WS upgrade bypasses Express's middleware
  entirely, so this has to happen directly in the `connection` handler, not
  via `req.colonyId`) and caches it on the connection for its lifetime.
  `broadcastState()` computes `getState(colonyId)` **at most once per
  distinct colony per call** (a `Map<number, string>` built fresh each
  tick), and every client sharing that colony gets the identical cached
  string — preserving the original "identical payload across simultaneous
  connections" guarantee per-colony instead of globally. An earlier version
  of this also sent an immediate `ws.send(getState(colonyId))` right on
  connect; that was removed because it meant two near-simultaneous
  connections to the *same* colony could independently compute `getState()`
  a tick apart and see slightly different creature positions — violating
  exactly the identical-broadcast guarantee `spec/realtime.test.ts` checks.
  A connection's first frame always comes from the next periodic broadcast,
  same as every pre-Crit-10 connection.
- **The client's WebSocket connects only after the first `GET /api/state`
  resolves, not alongside it.** The very first request from a fresh
  browser profile is what sets the `sid` cookie (`res.cookie(...)` in the
  session middleware); a WS upgrade request carries whatever cookies
  existed *before* that response landed, so opening it in parallel could
  race the cookie and mint a second, separate colony for the same player
  on the same page load. `main.ts` now chains the WS connection off
  `refresh().then(...)` instead of firing both at once.
- **Durable action log: every mutation writes a SQLite row and a stdout
  line, unconditionally, successes and failures together.** `log.ts`'s
  `logAction(colonyId, action, detail?)` is the one place either happens —
  an `action_log` table (`id, created_at, colony_id, action, detail`) for
  `GET /api/log` to read back, and a `console.log` one-liner
  (`[action] colony=<id> <action> <detail>`) for `flyctl logs` in
  production, since nobody tails a SQLite table there. `colony_id` is the
  acting colony rather than a player account, because there are no
  accounts in this model — a colony *is* the identity. `runBatchCommand`
  (`index.ts`) logs once per batch request with every attempted id and its
  per-id outcome (`errors`), not once per worker — "who tried what" is the
  useful signal, including the ids that failed because they belonged to
  someone else.
- **Test adaptation: `spec/colony.test.ts` and `spec/realtime.test.ts` gained
  a small persistent-cookie `request()` wrapper each (duplicated between the
  two files, and duplicated again from `spec/multiplayer.test.ts`'s own
  `createSession()` — never imported, since that file is deliberately
  self-contained and is never touched to make other tests pass), so every
  request in a given file now belongs to one consistent session/colony,
  matching what these pre-Crit-10 single-colony test suites already assume.
  `realtime.test.ts`'s wrapper also threads the current cookie into
  `connect()`'s WebSocket handshake headers (`new WebSocket(url, {headers:
  {cookie}})`), since a WS upgrade has no browser cookie jar to rely on.
  `spec/simulation.test.ts` calls `simulation.ts`'s `issue*Command`
  functions directly (bypassing HTTP entirely), so instead it passes the one
  `colony.id` it already captures at module load as the new required
  `ownerColonyId` argument at every call site — every synthetic worker in
  that file is already registered under that same colony, so this is always
  correct, never a guess.
- **Explicitly out of scope, same as the brief:** no passwords or accounts,
  no PvP, no predators, no world reset/population changes, no evolution.
  Nothing about ownership here touches combat, gathering mechanics, or
  reproduction cost — only *whose* worker/colony a command is allowed to
  act on, and whose ledger a deposit/reproduction spends from (both already
  fell out for free: a carrying worker's `colonyId` was always the one it
  was registered with, so it was already returning to and depositing into
  its own queen/ledger before this crit — Crit 10 only added the
  authorization check in front of issuing the command in the first place).

## Stage 6b: playtest world reset, population, and player guidance

Crit 10 made multiplayer real, but the deployed world was still the single
seeded colony/resource set every prior stage had accumulated on top of, and
nothing told a first-time visitor what to do. Stage 6b is explicitly **not**
a new gameplay-system stage — no predators, PvP, worker death, respawning,
evolution, or buildings — it's a one-time world reset plus denser,
deterministic seeding plus an in-game manual, so the existing multi-colony
game is actually playtestable. Every Crit 10 invariant above still holds
unchanged; nothing in this stage weakens authorization, ownership, or the
session→colony model.

- **World population is generated once, at module load, from a fixed
  literal seed — never `Math.random()`/`Date.now()`.** `buildWorldPopulation()`
  in `balance.ts` runs a `mulberry32(WORLD_SEED)` PRNG over the first
  `SPAWN_ANCHOR_COUNT` colony-spiral points (`colonySpiralPosition`, the same
  function `createColony()` uses — spawn anchors and actual colony spawn
  points are deliberately the same sequence, not two independent layouts),
  scattering `SUGAR_PER_ANCHOR`/`BIOMASS_PER_ANCHOR`/`APHIDS_PER_ANCHOR`
  pieces of content in a jittered cluster around each anchor (a fixed
  fraction of anchors also get a protein deposit, via
  `PROTEIN_ANCHOR_STRIDE`), plus a smaller scattering of each type across the
  whole map (`SCATTER_*_COUNT`) so the world isn't legible as "a ring of
  identical clusters." Every count and radius is a named constant in
  `balance.ts`, per the existing "balance constants never inline" rule —
  rebalancing density later means changing a number there, not touching the
  generator. `RESOURCE_NODES`/`APHID_SEED_POSITIONS` are computed once as
  `const WORLD_POPULATION = buildWorldPopulation()` and both `seedIfEmpty()`
  and `resetProductionWorld()` seed from that same array — there is still
  exactly one source of truth for initial world content, just a generated
  one instead of a hand-written literal list.
- **Content deliberately keeps clear of a spawn anchor itself** — every
  generated node and aphid sits outside a minimum radius of the anchor it
  clustered around, so a fresh colony's queen never spawns standing on top
  of a resource, and there's open ground around the queen for workers to
  path through. `spec/world.test.ts`'s Section-16B tests assert this
  directly, plus that every anchor has its own nearby sugar/biomass/aphid
  content and that anchors themselves stay well separated from each other.
- **Resources and creatures are global map content, not colony property.**
  Placing dense clusters near every spawn anchor is about layout only —
  every node and creature is still claimable/huntable by any colony's
  workers regardless of whose spawn it clustered near, exactly as before
  this stage. Nothing about ownership of a resource node or creature changed.
- **Production reset is a deliberate, one-time, explicitly-invoked
  operation — never automatic, and never a public endpoint.**
  `resetProductionWorld()` (`db.ts`) is only ever called from
  `scripts/reset-world.ts`, a CLI script that refuses to do anything unless
  invoked with a literal `--yes` flag (prints a refusal and exits nonzero
  otherwise); it is never imported or called from `index.ts`, so no HTTP
  route can trigger it and server boot/restart never runs it. This was run
  exactly once against the live deployment as part of shipping Stage 6b —
  see `PROCESS.md` for the exact invocation and the before/after counts it
  reported. Don't invoke it again outside another deliberate, user-directed
  reset.
- **A live server process must be restarted after `resetProductionWorld()`
  runs against its DB_PATH out from under it.** `loadSimulation()` only
  ever runs once, at process startup (`simulation.ts`'s top-level call) —
  it loads workers/creatures into in-memory maps and never reloads them
  afterwards. The reset script is a separate, short-lived process that only
  touches SQLite directly; an already-running app server (like the live Fly
  machine) keeps serving its stale pre-reset in-memory state over the API
  until it restarts, and its periodic `checkpointSimulation()` can briefly
  write that stale state's positions back over freshly-reseeded rows that
  happen to reuse the same ids (SQLite reuses rowids; these tables aren't
  `AUTOINCREMENT`). Discovered and fixed live during the one production
  reset (see `PROCESS.md`) by restarting the Fly machine immediately after
  the script ran; `scripts/reset-world.ts`'s own success output now prints
  this reminder.
- **The production reset preserves the session/ownership *model*, not any
  specific session.** It wipes `colonies`, `workers`, `colony_resources`,
  `resource_nodes`, `creatures`, and `sessions`, then reseeds from
  `seedIfEmpty()`/`seedCreaturesIfEmpty()` inside one `db.transaction()` —
  so there's never a half-reset state visible mid-transaction. Clearing
  `sessions` is deliberately not special-cased: an old `sid` cookie simply
  no longer resolves to a row, so `resolveOrCreateColony()`'s existing
  no-cookie-or-stale-cookie path mints a fresh colony for it exactly as it
  already does for a brand-new visitor — this is what "no dangling session
  ownership references" means in practice, and why it needed no new code in
  `sessions.ts` or `index.ts` at all.
- **`action_log` is deliberately preserved across a production reset, not
  wiped.** Crit 10 added durable logging specifically for evidence and
  accountability; a reset is exactly the kind of event that log should be
  able to show (who did what, right up until the reset happened), so
  erasing it at the one moment it would be most useful would defeat its own
  purpose. `resetForTests()` (test-only) still wipes `action_log`, since
  tests want a fully blank slate between runs and have no accountability
  need — don't confuse the two functions' behavior here, they're
  intentionally different. `resetProductionWorld()`'s returned
  `actionLogPreservedRows` count is how `scripts/reset-world.ts`'s summary
  (and `spec/world.test.ts`'s Section-16E test) prove the row count survived
  the transaction unchanged.
- **The in-game "How to play" overlay (`#help-button`/`#help-overlay` in
  `public/index.html`, wired up in `main.ts`) is the primary player-facing
  guide — not this file, not the README.** It documents the controls,
  objective, a numbered quick start, and a legend as they actually render
  today; if a future stage changes a control, a marker's shape/colour, or
  the reproduction cost, update the overlay's copy in the same change, the
  same way `spec/realtime.test.ts` has to be updated alongside the
  broadcast contract it checks. It never touches `state` or issues a
  command — opening/closing it has zero interaction with simulation or
  selection, so it's safe to open mid-drag or mid-selection with no side
  effects.
- **Small readability polish, not an art pass.** Own-queen (gold) vs.
  other-colony-queen (purple) vs. worker (blue) colour coding, the dashed
  selection ring, and the small carrying-badge dot all predate this stage
  (Crit 10/Stage 4); Stage 6b's own pass confirmed these already satisfy the
  brief's "own vs. other, basic legibility" bar at the new, denser content
  levels rather than redesigning them.
- **`spec/world.test.ts` is the dedicated regression suite for this stage**
  (deterministic seed counts and exact pinned coordinates, multi-colony
  spawn support, starting colony state for both the seeded and a freshly
  minted colony, world-wide distribution, the reset mechanism at both the
  function level and the CLI-script level via a real subprocess, the
  simulation layer loading every seeded aphid, and a lightweight
  `jsdom`-based check of the served Help markup — no headless browser). It
  follows `spec/simulation.test.ts`'s direct-module-import-with-overridden-
  `DB_PATH` pattern for everything except the Help check, which follows
  `spec/invariants.test.ts`'s `inject("baseUrl")` + `fetch` + `JSDOM`
  pattern instead.

## Stage 7: predators & worker survival

Every stage through 6b made the world richer but added no risk: more
workers was pure upside. Stage 7 adds exactly one hostile species
("spider") plus real worker health/death, closing the loop into gather →
risk → flee/fight → injury/death → carcass → reproduce. Queens are never
touched — no HP, no death, no PvP — and there's still only one predator
species, no worker corpses, and no automated colony defenses.

- **Worker health follows creature health's exact two-part durability
  contract, not a new one.** `workers` gained `health`/`max_health` columns
  the same way `creatures` did in Stage 6: an inline `CREATE TABLE IF NOT
  EXISTS` declaration for a genuinely fresh DB, plus a guarded
  `migrateWorkerHealth()` (`ALTER TABLE`, PRAGMA-checked, no-op if already
  present) for an existing deployed DB, plus `backfillWorkerHealth()`
  (`UPDATE ... WHERE max_health IS NULL`, using `WORKER_MAX_HEALTH = 30`)
  so "health IS NULL" never persists past one boot. Fresh workers (initial
  seed, `reproduce()`, and `createColony()`'s starting-worker spawn) all set
  `health = max_health = WORKER_MAX_HEALTH` explicitly rather than relying
  on backfill alone. Health/maxHealth are written synchronously to SQLite on
  every hit (`applyDamageToWorker`), same as creature health — not batched
  into the periodic position checkpoint.
- **Worker death is a single `DELETE`, no transaction, and that's the
  entire carried-resource-on-death rule.** `killWorker` deletes the
  `workers` row outright. There's no separate worker-carcass concept and no
  special-case code for "what happens to the payload" — deleting the row
  deletes `carrying_type`/`carrying_amount` with it, and because the row no
  longer exists, nothing can ever later run `attemptDeposit` for that
  worker id. A dead worker can't be commanded either, for the same
  structural reason: `issueMoveCommand`/`issueGatherCommand`/
  `issueAttackCommand` already treat a missing id as `"no such worker"` —
  no new guard was needed. A carrying worker that's under attack keeps
  auto-returning regardless of taking damage; spider AI never touches
  `worker.command`, so there's no code path where it would auto-fight-back
  or auto-flee — verified by test, not by new guard code.
- **Spider AI is a third `CreatureCommand` variant (`chase`), reusing every
  durability/live-lookup idiom Stage 5/6 already established** — never
  persisted, always dropped back to idle on `loadSimulation()`, and its
  target is looked up live via `workers.get(targetWorkerId)` every tick
  (never a captured position), mirroring how a worker's own `attack`
  command re-reads its creature target live. When idle/wandering, a spider
  scans the full shared `workers` Map — deliberately ownership-blind, same
  as a worker's own attack can target any colony's creature — for the
  nearest worker within `SPIDER_AGGRO_RANGE` (200), tie-broken by ascending
  worker id for determinism, and switches to `chase`. While chasing, it
  disengages back to idle once its target is dead or beyond
  `SPIDER_DISENGAGE_RANGE` (300, deliberately larger than the aggro range so
  a chase doesn't immediately re-trigger at the boundary), otherwise closes
  to `SPIDER_ATTACK_RANGE` (30) and attacks on a `SPIDER_ATTACK_COOLDOWN`
  (1s) once there, dealing `SPIDER_ATTACK_DAMAGE` (10 — three hits kill an
  isolated worker, mirroring the existing "three worker hits kill an aphid"
  balance note). Idle/wander behavior itself (the non-chase branches) was
  refactored out of the aphid-only code into a shared, species-parameterized
  `advanceWander()`/`WANDER_PARAMS` lookup, so spiders reuse the exact same
  deterministic per-creature xorshift wander cycle aphids already had —
  no second wander implementation.
- **Queen immunity is structural, not a guard clause.** Queens live only in
  the `colonies` table and are never inserted into the `workers` Map, so a
  spider's aggro scan (which only ever iterates `workers.values()`) can
  never select one — there is no `if (target is queen) skip` anywhere
  because there's no code path that could reach a queen in the first place.
- **No-PvP is also structural, not a guard clause.** `issueAttackCommand`
  only ever resolves `creatureId` against the `creatures` Map; it has no
  code path that could resolve to a `SimWorker`. Passing another colony's
  worker id as a `creatureId` can only ever produce `"no such creature"` —
  or, in the single unlikely edge case of a numeric id coincidentally
  matching a row in the *other* table, a real, unrelated creature, never the
  targeted worker. (`workers` and `creatures` are separate SQLite tables
  with independent autoincrement counters, so a `workers.id` and a
  `creatures.id` can legitimately collide — `spec/multiplayer.test.ts`'s
  no-PvP regression test deliberately provokes exactly this by passing
  `creatureId: otherColonysWorker.id`, and explicitly cancels whatever
  command that accidentally started before the test ends, so it can't leak
  a live background attack into a later test's assertions.)
- **Two-layered nest exclusion keeps ambient spider wander/aggro away from
  a colony's spawn, because one layer alone proved insufficient.**
  `nestPositions` (populated at boot and kept current via `registerColony()`
  for every colony ever minted, not just the original world-gen anchors) is
  the shared reference both layers check against:
  1. `pickWanderTarget` rejects (or, if already inside one, escapes out of)
     any spider wander *endpoint* within `SPIDER_CLEAR_RADIUS` (400) of any
     nest — the first fix, and the one the initial implementation shipped
     with.
  2. That alone was insufficient: a straight-line wander step between two
     endpoints that are each individually clear of every nest can still
     *pass through* a nest's clear zone partway along the path, and because
     `SPIDER_AGGRO_RANGE` (200) is smaller than `SPIDER_CLEAR_RADIUS` (400),
     a transiting spider could still end up close enough to aggro a
     stationary, unclaimed colony's motionless starting workers — who never
     move until a session claims and commands them — reproducing the exact
     "colony elimination" symptom the first fix was meant to prevent, via a
     different mechanism. This was found empirically (full black-box suite
     runs, not by inspection), via dev-log causal correlation on a
     `colony_claimed {"workerCount":0}` entry. The actual fix gates the
     aggro *trigger*, not the spider's possible paths: `advanceSpider`'s
     idle/wander aggro scan skips any candidate worker who is themselves
     standing inside a nest's clear zone, reusing the same
     `isClearOfNests()` helper. This is simpler and more robust than trying
     to constrain every path a spider's position could take, and has the
     accepted (even desirable) side effect of making the area right around
     any colony's queen a small permanent safe zone from ambient spider
     aggro. A chase already in progress is deliberately left unconstrained
     by both layers — a worker that strayed out and is now fleeing home
     being legitimately caught is predation, not ambient camping.
- **Spider death reuses `killCreature`'s existing one-transaction
  death+carcass mechanism unchanged** — `CREATURE_PROTEIN_VALUE` was
  generalized from a hardcoded `APHID_PROTEIN_VALUE` lookup into a
  species-keyed map (`SPIDER_PROTEIN_VALUE = 100`), and `killCreature` now
  returns the new carcass's resource-node id so a lethal hit on a spider can
  log `spider_died { creatureId, carcassId }` — the one new log line this
  stage adds (an aphid kill still logs nothing extra, gated on
  `species === "spider"`, so existing aphid-combat assertions are
  untouched). A carcass worth `SPIDER_PROTEIN_VALUE` (100) must still be
  gathered explicitly like any other node — no auto-harvest, same as an
  aphid's.
- **Spider population is seeded via the same idempotent, boot-time
  mechanism as every other migration/seed function — no reset, no manual
  script.** `seedCreaturesIfEmpty()` was generalized from a single
  hardcoded `'aphid'` INSERT into a loop over every species' seed positions
  (`{ aphid: APHID_SEED_POSITIONS, spider: SPIDER_SEED_POSITIONS }`), so a
  genuinely fresh world seeds both species in one pass under the same
  `COUNT(*) FROM creatures == 0` gate. A second, independently-gated
  `seedSpidersIfMissing()` (`COUNT(*) FROM creatures WHERE species='spider'`)
  runs unconditionally right after it: on a fresh DB it's a no-op (the first
  pass already seeded spiders, so the count is already nonzero); on an
  *existing* production DB that already has aphids (and so never triggers
  the first function's empty-table gate), it adds the full
  `SPIDER_SEED_POSITIONS` population automatically on the very next boot —
  exactly once, with no risk of duplication on any later restart, since the
  gate is a live count, not a one-time flag. This is race-free specifically
  because the app runs as a single `shared-cpu-1x` Fly machine with
  `--ha=false` (confirmed via `fly.toml`) — there is never a second OS
  process racing the same DB file at boot. `SPIDER_SEED_POSITIONS` itself is
  generated by `buildWorldPopulation()` the same deterministic way
  `APHID_SEED_POSITIONS` is (fixed `mulberry32(WORLD_SEED)` seed, scattered
  rather than anchor-clustered, kept `SPIDER_CLEAR_RADIUS` from every spawn
  anchor). `resetProductionWorld()` needed no code change at all — it
  already calls `seedCreaturesIfEmpty()` after wiping `creatures`, so once
  that function seeds every species on an empty table, a full reset
  produces spiders for free.
- **Simultaneous/concurrent kill safety is the existing code, not new
  logic, in both directions.** Two spiders attacking the same worker in one
  tick: `killWorker`'s sweep (any spider whose `command.type === "chase"`
  targets the now-dead worker drops to idle) runs before `advanceCreatures`
  reaches a later spider in the same single-threaded pass over
  `creatures.values()` (itself ordered deterministically — `loadSimulation`
  queries `ORDER BY id`), so a second spider reaching the same dead target
  later in that pass already sees the sweep's effect. Two workers attacking
  the same spider: `handleAttackCommand`'s existing `if (!creature) { ...
  idle ...}` guard (Stage 6) makes a second hit on an already-dead creature
  a no-op, true for spiders with zero new code. Both are covered by explicit
  regression tests rather than relying on the general argument alone. One
  harmless, documented asymmetry: because `advanceCreatures(dt)` runs before
  the worker command loop each tick, a spider's chase step is computed
  against a worker's *previous*-tick position, while a worker chasing a
  creature uses the creature's *current*-tick position (creatures already
  moved earlier in the same tick) — a ~100ms lag with no practical effect at
  this scale.
- **Client/Help changes are additive, not a redesign.** Spiders get a
  distinct danger-red marker (`drawSpider`, six radiating "leg" strokes) and
  their own click radius (`SPIDER_RADIUS`), never the aphid's green diamond.
  Both `workers` and `otherWorkers` render loops gained a
  `drawHealthBar(...)` call, reusing the exact same no-op-above-full-health
  helper creature health already used — no new conditional logic needed. The
  in-game Help overlay (the primary player-facing guide — see Stage 6b)
  gained a "Danger" section and two legend rows; `spec/world.test.ts`'s
  Section 16H test was extended with matching `toMatch` assertions so the
  two can't silently drift apart, same discipline as every other Help-copy
  change.
- **Performance was measured, not assumed.** A full-population timing check
  (52 seeded aphids + 10 seeded spiders + 93 workers across 31 colonies, all
  given live attack commands so every tick does real movement/combat work,
  not idle wander) measured `advanceSimulation()` at ~0.11ms/tick average
  over 500 ticks — roughly 900x headroom under the 100ms (10Hz) tick
  budget. The spider aggro scan is O(spiders × workers) with no spatial
  index, which this confirms is trivial at the target scale; revisit if
  either population grows by orders of magnitude.
- **Restart/persistence needed no *spider*-specific test, on top of what
  this stage already added for worker health generally.** A dedicated test
  ("a restart preserves survivor health and a dead worker's absence") was
  added earlier in this stage for worker health/death specifically; Stage
  6's existing generic creature-restart tests (ephemeral command resets to
  idle, durable health/carcass state survives a reload) already exercise
  the exact same species-agnostic `killWorker`/`loadSimulation()` machinery
  a spider kill goes through. Since none of that code branches on species, a
  separate spider-specific restart test would only duplicate coverage —
  judged unnecessary, consistent with this project's standing preference
  against mechanically-generated, redundant tests.

## Stage 8: queen survival, colony defeat & restart

Stage 7 made individual workers vulnerable but left the colony itself
immortal — a colony that lost every worker and had insufficient protein to
reproduce was permanently soft-locked, with no in-game recovery. Stage 8
closes that loop on both ends: the queen herself can now be damaged and
killed (environmentally, by spiders — still never by another player), and
symmetrically, a player can always recover from a bad outcome via an
explicit, player-controlled Abandon Colony → Start New Colony flow. The
shared world itself never resets from any individual colony's defeat or
restart — only that one colony's own state is lost, and it remains behind
as a visible, non-interactable ruin.

- **Colony lifecycle lives on the `colonies` row itself, not a parallel
  table.** `status` (`'active' | 'defeated'`), `queen_health`,
  `queen_max_health`, `defeat_cause`, `defeated_at` are new nullable columns
  (`migrateColonyLifecycle()`/`backfillColonyLifecycle()`, mirroring Stage
  7's worker-health migration guard-and-backfill pattern exactly — SQLite
  can't retroactively add a `NOT NULL`/`DEFAULT` to an existing column, so
  the backfill is what actually guarantees no row is ever left with a NULL
  status in practice, not the `CREATE TABLE`'s own constraint). Every fresh
  colony insert (`seedIfEmpty`, `createColony`) sets
  `status='active', queen_health=queen_max_health=QUEEN_MAX_HEALTH`
  explicitly, same as Stage 7 did for fresh worker health.
- **Session→colony is one current mapping per session, re-pointed on
  restart — not a history table.** `saveSession()` became an upsert
  (`ON CONFLICT(id) DO UPDATE SET colony_id = excluded.colony_id`). Starting
  a new colony simply re-points a session's one existing row to a fresh
  colony id; the old, now-defeated colony row is never deleted, so it
  persists unreferenced in `colonies` as a de facto historical ruin. This
  was chosen deliberately over a separate history/log table — nothing
  needs to query "every colony a session has ever had," only "which colony
  does this session currently control."
- **The in-memory colony cache (`simulation.ts`'s `colonies` Map) replaced
  the old narrow `nestPositions` Map.** Every consumer of what used to be
  queen position lookups (`isClearOfNests`, `resolveTarget`'s `return`
  command resolution) now reads from this richer `SimColony` cache
  (`x, y, health, maxHealth, status, timeSinceLastDamage`). `status`
  filters out defeated colonies from `isClearOfNests`/
  `nearestViolatingNest` — a ruin protects nothing. `timeSinceLastDamage`
  is ephemeral, like every other in-flight simulation state: it resets to 0
  on every `loadSimulation()`, so a just-restarted queen simply waits out
  one more regen delay before healing, never an immediate burst on reload.
- **Queen damage is synchronous-write; queen regen is checkpoint-batched —
  the same durability split this project already draws between combat and
  passive/position state.** `applyDamageToQueen` writes `queen_health` to
  SQLite immediately on every hit, exactly like `applyDamageToWorker`.
  Passive regen (`advanceQueenRegen`, run once per tick) only updates the
  in-memory value; those increments ride along in the existing periodic
  `checkpointSimulation()` flush instead of writing every tick. Losing at
  most one checkpoint interval of regen progress on an ungraceful crash is
  harmless, the same argument already used for worker/creature position.
  `QUEEN_MAX_HEALTH` (200), `QUEEN_REGEN_DELAY` (10s undamaged before
  regen starts), `QUEEN_REGEN_RATE` (2 HP/s) are named constants in
  `balance.ts`, same discipline as every other tunable number in this
  codebase.
- **Spider queen-targeting is strictly a fallback behind worker-targeting,
  and deliberately ownership-blind — same as worker-targeting already
  was.** `advanceSpider`'s existing worker-aggro scan runs first,
  unchanged; only if it finds no valid worker does a second scan run,
  against `colonies.values()` filtered to active, within
  `QUEEN_AGGRO_RANGE` (200), nearest-then-id tie-break — the exact same
  shape as the worker scan's own tie-break. `QUEEN_AGGRO_RANGE`/
  `QUEEN_DISENGAGE_RANGE` (300) are their own named constants (not reused
  from the worker ones), even though initially equal in value, so queen
  and worker tuning can move independently later. A new `chase-queen`
  `CreatureCommand` variant is purely additive alongside the existing
  `chase` — never a rename — and follows the identical live-lookup
  discipline (`colonies.get(targetColonyId)` fresh every tick, never a
  captured position): if the target no longer exists or is no longer
  active, the spider drops to idle immediately, which is the entire
  mechanism behind "spiders never attack a ruin" and "a spider stops
  targeting a queen the instant she's defeated."
- **The queen-aggro scan deliberately applies no `isClearOfNests` gate —
  this is intentional, not an oversight, and mirrors an asymmetry Stage 7
  already established for worker chases.** `isClearOfNests` exists to keep
  a spider's *ambient wander/aggro-scan* out of a nest's safe zone; reaching
  a queen at all requires already being inside that zone by definition, so
  a spider can only ever "notice" a queen as the natural result of having
  wandered or chased its way in — never from across the map via a special
  distance check. This is exactly the same reasoning Stage 7 documented for
  why a chase already in progress bypasses `isClearOfNests` for workers.
- **`defeatColony(colonyId, cause, creatureId?)` is the single
  authoritative, idempotent entry point for ending a colony's life —
  reached from both a lethal queen hit and manual abandonment. No second
  reset system exists anywhere.** Idempotency is enforced by the database,
  not caller discipline: `UPDATE colonies SET status='defeated', ... WHERE
  id=? AND status='active'` affects zero rows on a second call (e.g. two
  simultaneous lethal hits in the same tick, or a race between a hit and a
  manual abandon), so everything after that guard — worker/resource
  deletion, the in-memory sweep, logging — runs exactly once no matter how
  many triggers fire concurrently. Inside one `db.transaction()`: every
  worker row for that colony is deleted (cascading its carried resources
  for free, the same rule Stage 7 established for a single worker's death)
  and `colony_resources` is wiped (stored resources are lost). After the
  transaction commits: the in-memory `workers` Map drops those ids, every
  spider chasing one of them (or chasing this queen directly) is swept back
  to idle (mirrors `killWorker`'s own attacker-idle sweep), and the
  in-memory `SimColony` entry flips to `status: "defeated", health: 0` —
  position is kept, since that's the ruin's marker. Exactly one
  `colony_defeated` log line is written, guaranteed by the same guard.
- **Abandonment is not a second pipeline — it's `defeatColony` called with
  a different cause, and nothing else.** `actions.ts`'s `abandon(colonyId)`
  only checks the colony is still active, then calls
  `defeatColony(colonyId, "abandoned")`. It deliberately does NOT require
  the caller to have a worker or any resources — a colony stuck at zero
  workers and insufficient protein to reproduce must still be abandonable,
  which is the entire point of this feature existing. The client's
  confirmation modal uses the exact wording in `public/index.html`'s
  abandon-overlay markup — don't reword it without a reason, since it's
  the one place a player is told what they're about to lose.
- **Authorization against a defeated colony comes from lifecycle status
  itself, never incidentally from "no workers exist to find."** Each of
  `issueMoveCommand`/`issueGatherCommand`/`issueAttackCommand`
  (`simulation.ts`) and `reproduce()`/`abandon()` (`actions.ts`) checks
  `isColonyActive(ownerColonyId)` before any worker/resource lookup,
  returning a `"colony defeated"` error otherwise. This matters because a
  defeated colony's workers are deleted by `defeatColony` anyway — without
  this explicit check, rejection would just happen to fall out of "no such
  worker," which is the wrong invariant to depend on (e.g. it would say
  nothing about `reproduce()`, which never looks at workers at all).
- **Start New Colony's eligibility is "valid session + defeated current
  colony" — never resource balance.** `startNewColony(sessionId,
  currentColonyId)` (`sessions.ts`) guards only `isColonyActive`, rejecting
  with `"colony still active"` if the caller's current colony hasn't been
  defeated yet (this is what stops a client from starting unlimited
  colonies while one remains active). On success it reuses the exact same
  `claimColonyForSession` helper `resolveOrCreateColony` already uses
  (factored out of what used to be inlined there) — claim-unclaimed-or-mint,
  `saveSession` upsert, re-top-up the spare invariant — then logs
  `colony_started` with `previousColonyId`. Abandon and Start New Colony are
  always two separate requests; nothing auto-creates a new colony in the
  same request that defeats the old one.
- **The spare, unclaimed colony invariant (Crit 10) gained an
  `status = 'active'` filter, closing a new edge case that only exists once
  colonies can be defeated.** `getUnclaimedColonyId()`'s query now requires
  `c.status = 'active'` — without this, a spider could kill a spare colony's
  queen before any session claims it, and that defeated spare would
  otherwise be silently handed out as someone's "fresh" starting colony. A
  defeated, unclaimed spare is simply invisible to future claims now; the
  very next claim attempt mints a brand-new one in its place, same as the
  pre-Stage-8 "mint if none unclaimed" behavior.
- **A fresh colony's spawn point avoids every existing colony/ruin position
  and every live spider, via a small bounded retry — not a new world-gen
  system.** `createColony()` gained an optional `avoid: {x,y,radius}[]`
  parameter; `pickSpawnPosition` tries successive spiral indices
  (`SPAWN_RETRY_ATTEMPTS = 20`) until one clears every avoidance entry,
  falling back to the plain spiral position if none do within the bound —
  deterministic, bounded, never an open-ended search. `sessions.ts`'s
  `buildSpawnAvoidance()` builds this list from every colony's position
  (active *and* defeated — a new colony must avoid landing on a ruin too)
  plus every live spider's current position (`getSpiderPositions()`, a new
  `simulation.ts` export). Accepted, documented tradeoff: repeated
  abandon/restart cycles push new colonies further out on the same
  golden-angle spiral over time, same as repeated ordinary colony creation
  already did pre-Stage-8 — not solved here, and not worth solving with a
  bigger system for what this project needs.
- **The WebSocket broadcast loop must re-resolve a connection's colony on
  every tick, not cache it once at handshake — this was a real bug, not a
  hypothetical.** Pre-Stage-8, a connection cached `colonyId` once at
  `wss.on("connection", ...)` from the session cookie, which was safe only
  because a session's colony never changed for the life of a connection.
  Stage 8 breaks that assumption: Start New Colony re-points a session's
  `colony_id` without touching its cookie or closing any open socket, so an
  already-open connection that still cached the old `colonyId` would
  broadcast a now-defeated colony's state forever after a restart — no
  reload ever showed the new colony. The fix caches `sessionId` instead
  (immutable for the connection's life) and calls `getColonyForSession
  (sessionId)` fresh inside `broadcastState()` every tick — one indexed
  `sessions` lookup per connection, the same cost the per-request HTTP
  middleware already pays. This is what makes a restart appear live over an
  already-open socket with no reload. See `spec/realtime.test.ts`'s
  restart-broadcast test; don't reintroduce colonyId caching at the
  connection level without re-checking this.
- **The world event feed is derived from the existing `action_log`, not a
  new table or a chat system.** `log.ts`'s `getWorldEvents(limit = 6)` is a
  bounded, indexed, newest-first query over exactly four action types
  (`worker_died` with `cause: "spider"`, `spider_died`, `colony_defeated`,
  `colony_started`), mapped through a small fixed set of safe public
  message templates — never raw `detail` JSON, never a colony→session
  mapping, never free text. Folded into `getState()`'s existing response as
  `worldEvents`; no new endpoint or client polling cycle. Per-hit queen
  damage is deliberately never logged to `action_log` (it would be pure
  noise at 10Hz) — the realtime broadcast already surfaces it live without
  a durable log entry per hit, same reasoning Stage 7 used for not logging
  the same for workers.
- **No PvP, reaffirmed structurally, not just by convention.** Everything
  that made this true through Stage 7 is untouched: `issueAttackCommand`
  still only ever resolves `creatureId` against the `creatures` Map, never
  `workers`; queen-targeting is spider AI only, with zero code path by
  which a player action could ever damage another player's queen. Starting
  a new colony and abandoning one are both always resolved from the
  caller's own server-side session — never a colony id accepted from a
  request body — so a client can never abandon or restart someone else's
  colony.
- **Explicitly out of scope, same as the brief:** no PvP, no player attacks
  on foreign queens/workers, no resource stealing, no defensive buildings,
  no soldier caste, no queen movement, no eggs/larvae, no automated
  defense, no spider nests, no predator reproduction, no hunger/ecology, no
  evolution, no fog of war, no multiple worlds, no ruin looting, no ruin
  decay.

## Stage 9: evolution & colony specialisation

Stage 8 made colony growth survivable but still purely numerical — gather,
reproduce, do the same things with more workers, with no strategic
differentiation between colonies regardless of how they grew or how long
they've survived. Stage 9 attaches a permanent, player-chosen identity to a
colony's *lineage*, not its session: at three peak-population milestones
(5/10/20 workers), the player picks one of three permanent traits per tier
(Foraging/Survival/Brood), freely mixable across tiers with no
prerequisites and no respec, which durably modify existing mechanics —
carry yield, gather timing, movement speed, worker max health, attack
damage, and reproduction cost. Still no PvP, no production reset, and no
new creature/building/caste system.

- **Evolution belongs to the colony's lineage, not the session or the
  player.** `peak_population` and `evolution_tier1/2/3` live on the
  `colonies` row itself, the exact same place Stage 8's lifecycle columns
  live, with the exact same migration shape (`migrateColonyEvolution()`/
  `backfillColonyEvolution()` mirror `migrateColonyLifecycle()`/
  `backfillColonyLifecycle()` precisely — guarded `ALTER TABLE`, no-op if
  already present). A session re-pointing to a new colony (Start New
  Colony) gets none of the old colony's evolution, because nothing ever
  copies these columns between colony rows — the same "no inheritance path
  exists because no code path copies it" argument Stage 8 already
  established for queen health/status.
- **Peak population is monotonic and is the only eligibility signal —
  current population never relocks a tier.** `maybeUpdatePeakPopulation()`
  (`simulation.ts`) only ever raises `peak_population`, called from
  `reproduce()` right after a new worker is registered (the only path that
  increases a colony's worker count). Losing workers to a spider never
  lowers it, and `selectEvolution()`'s eligibility check
  (`peak_population >= tierThreshold(tier)`) reads this durable counter,
  never `getWorkersForColony(id).length`. Backfill for colonies that
  predate this stage is a conservative floor — current living worker count,
  or `1` for an already-defeated ruin with zero workers — never a fabricated
  higher number.
- **Exactly one selection per tier, enforced by the database, not by caller
  discipline — the same idempotency shape `defeatColony()` already
  established.** `applyEvolutionSelection()`'s guard,
  `UPDATE colonies SET evolution_tierN = ? WHERE id = ? AND evolution_tierN
  IS NULL`, affects zero rows on a second call (a lost race, or a tier
  that's simply already chosen), so `selectEvolution()`'s cheap pre-checks
  (tier validity, choice validity, colony active, peak population,
  not-already-chosen) are just a fast, friendly error path in front of a
  real guarantee that holds even under a genuine concurrent race — see
  `spec/evolution.test.ts`'s `Promise.all` double-POST test, which resolves
  to exactly one `[200, 400]` outcome. There is no prerequisite between
  tiers and no respec path anywhere in the code — a colony can go straight
  to Tier II Survival without ever having picked a Tier I trait at all.
- **One central modifier function, not scattered `if evolution === ...`
  checks.** `src/server/evolution.ts`'s `getEvolutionModifiers(selections)`
  is the single place every one of the seven derived values (carry yield,
  gather duration, carrying move-speed multiplier, chase-speed multiplier,
  max health, attack damage, reproduce cost) is computed from a colony's
  three tier strings. Every call site — gather claim, movement, combat,
  reproduction — calls this once and reads the field it needs, rather than
  re-deriving branch logic locally. Every selected trait affects *all* of
  that colony's existing and future workers immediately — there's no
  per-worker evolution state, only a per-colony one read fresh at the point
  of use.
- **Brood's discount is tier-effective, not cumulative.** Picking Brood at
  multiple tiers doesn't stack — `getEvolutionModifiers` scans
  `[tier3, tier2, tier1]` in that order and applies only the highest
  selected Brood tier's multiplier (50%/35%/20% off at Tier III/II/I
  respectively), defaulting to no discount if Brood was never chosen at
  any tier. "Foraging I + Brood II" gets exactly Tier II's discount, never
  Tier I's discount plus Tier II's.
- **Survival I retroactively converts every living worker's health by
  percentage, not by a flat heal or a silent mismatch against the new
  max.** This is genuinely new logic with no prior precedent in this
  codebase — every other max-health write (worker creation, `reproduce()`)
  sets `health = maxHealth` at creation time; nothing before this stage had
  ever rescaled an existing live entity's max health. On selecting Tier 1
  Survival, every living worker of that colony gets
  `newHealth = round((health / oldMaxHealth) * newMaxHealth)`, written to
  both SQLite and the in-memory cache inside the same transaction as the
  selection itself — an injured worker stays proportionally injured after
  the upgrade, never fully healed and never left stale relative to a max
  that just changed under it. Damage/death logic (`applyDamageToWorker`,
  `killWorker`) needed zero changes — they already operate on whatever
  `health`/`maxHealth` currently is.
- **Foraging II required a genuinely new mechanic, not a constant
  tweak — gathering had no duration to shorten.** Every gather before this
  stage was instantaneous on arrival: `attemptGatherClaim()` fired the
  instant a worker reached `GATHER_RANGE`. "Gather 30% faster" has nothing
  to speed up against an instant action, so this stage introduces the
  smallest meaningful duration mechanic: a short, universal
  `GATHER_DURATION` (1 second) channel between arrival and claim, applying
  to every worker regardless of evolution, that Foraging II shortens via
  division by its speed multiplier. This is a plain in-memory countdown on
  the worker's existing gather command object (`channelRemaining`), the
  same idiom the attack command's `cooldownRemaining` already used — no new
  column, no new persistence, and it's deliberately small enough not to
  disrupt the generous timeouts the existing gather-round-trip tests
  already relied on (though those timeouts were still lengthened — see
  below).
- **Foraging III and Survival III are per-tick dynamic multipliers on
  `WORKER_SPEED`, never a stored per-worker speed stat.** Foraging III's
  carry-speed bonus applies only while `worker.carrying !== null` during
  the `return` movement step; Survival III's chase-speed bonus applies only
  while the worker's command is `attack`. The pre-existing invariant that a
  carrying worker can never also be mid-attack (Stage 6's
  `issueAttackCommand` guard) means these two bonuses can never stack —
  confirmed preserved, not new code.
- **No PvP, reaffirmed structurally under two new combat-adjacent
  modifiers.** Survival II's attack-damage bonus and Survival III's
  chase-speed bonus are both applied as numeric substitutions purely within
  `handleAttackCommand()`'s existing path, which resolves `creatureId`
  only against the `creatures` Map — never `workers` — exactly as every
  prior stage's no-PvP guarantee already relied on. Neither modifier
  changes what a worker can target, only how hard/fast it fights whatever
  it was already allowed to fight.
- **`POST /api/evolve` follows the exact authorization shape every other
  mutating route already uses.** Body is `{ tier, choice }` only;
  `colonyId` is resolved exclusively from `req.colonyId` (session
  middleware), never trusted from the request body, matching
  `/api/reproduce`, `/api/abandon`, `/api/start-new-colony`, and every
  `/api/command/*` route. A forged `colonyId` in the body can never select
  evolution on someone else's colony — confirmed both by code reading and
  by `spec/evolution.test.ts`'s forged-id test.
- **Ruins retain their evolution history forever, affecting nothing.**
  `defeatColony()` was given zero new code for this stage — it already
  never touches `peak_population`/`evolution_tier*`, so a defeated colony's
  final peak population and every trait it ever chose simply remain on its
  row, visible in the public roster (`colonies[].peakPopulation`,
  `evolutionTier1/2/3`, `defeatCause`) exactly like Stage 8's `status`
  already was. A replacement colony via Start New Colony gets a genuinely
  blank lineage — `createColony()` explicitly sets
  `peak_population = STARTING_WORKER_COUNT` and leaves all three tier
  columns `NULL` on every fresh INSERT, the same explicit-not-backfill-only
  discipline every other lifecycle column already follows.
- **No hover/tooltip/inspection system was built for ruin history — the
  existing public roster already carries enough to list it.** The client's
  Evolution panel's "Other colonies" section is a plain list driven by the
  same `colonies` array Stage 8 already sent, now carrying
  `population`/`peakPopulation`/`evolutionTier1/2/3`/`defeatCause` — no new
  canvas hit-testing or rendering machinery, per the brief's explicit
  warning against building a complex inspection system for this.
- **Evolution availability is surfaced non-blockingly — never an interrupt,
  never auto-opened.** A small badge appears on the existing modal-button
  Evolution control (same overlay idiom as Help: `z-index: 10`,
  Escape/backdrop-dismissible, never the urgent `z-index: 20` tier
  Abandon/Defeat use) when at least one tier is unlocked and unchosen,
  computed client-side from the mirrored threshold constants. The player
  opens it whenever they choose; nothing about reaching a milestone pauses
  or redirects play.
- **Existing timing-sensitive tests needed longer deadlines, not weaker
  assertions, because of the new gather channel.** `GATHER_DURATION` adds
  real, fixed latency to every gather round trip on top of travel time —
  `spec/colony.test.ts`'s idle-worker-wait and busy-worker polling
  deadlines were lengthened (15s→30s) to accommodate this, with the reason
  stated inline as a comment; no assertion's actual expected outcome
  changed.
- **Performance was re-measured at a larger scale, not assumed safe by
  extension.** A throwaway script (not committed) grew 30 colonies to 20
  peak population each via real `reproduce()` calls, gave every one of them
  a distinct evolution build (pure Foraging/Survival/Brood, a mixed build,
  and an unevolved control), put all 690 resulting workers into active
  gather/attack commands, and measured `advanceSimulation()` at
  ~0.72ms/tick average over 500 ticks — still roughly 139x headroom under
  the 100ms (10Hz) tick budget. This is higher than Stage 8's measured
  ~0.19ms/tick (93 workers, 30 colonies), consistent with roughly 7.4x more
  workers doing real per-tick work (channel countdowns, evolved movement/
  combat multipliers included), not a regression.
- **Explicitly out of scope, same as the brief:** no respec/un-evolve, no
  soldier/scout castes, no genetics/breeding, no evolution-driven PvP, no
  balancing pass on the provisional percentages, no new creature or
  building types, no production world reset.

## Stage 10: Worker Castes & Fog of War

Stage 9 gave colonies a permanent identity but every worker was still
functionally identical. Stage 10 adds two independent systems on top of
that: a durable **caste** a worker is born into (worker/soldier/scout, each
with its own base stats), and **fog of war**, a visibility mechanic that
hides the shared world outside each colony's own units' sight. The two are
unrelated except that caste determines a unit's own vision radius.

### Castes

- **Caste is a durable, per-worker property, not a transient UI label.**
  `workers.caste` (`'worker' | 'soldier' | 'scout'`, `Caste` type in
  `balance.ts`) is set once at creation (initial seed, `reproduce()`,
  `createColony()`'s starting workers) and never changes afterward — there
  is no respec, same precedent Stage 9 already set for evolution tiers.
  `migrateWorkerCaste()` (`db.ts`) adds the column as `NOT NULL DEFAULT
  'worker'` directly (no separate backfill pass needed, unlike worker
  health — `'worker'` is the only honest value for every pre-Stage-10 row,
  since soldiers/scouts never existed before this stage).
- **One central table of base stats, same discipline Stage 9's
  `getEvolutionModifiers` already established for evolution.**
  `CASTE_BASE_STATS` (`balance.ts`) holds `maxHealth`/`attackDamage`/
  `speed`/`reproduceCost`/`carryCapacity` per caste. Worker is exactly the
  pre-Stage-10 baseline (reuses the existing flat constants verbatim, not
  duplicated numbers), so every pre-Stage-10 worker behavior and test is
  preserved byte-for-byte. Soldier (higher health/damage, faster, can't
  gather) and Scout (fragile, fast, wide vision, small carry) are the
  brief's own suggested placeholders — no balancing pass attempted.
  Evolution (Stage 9) still applies its own multipliers on top of whichever
  caste's base stats apply (`getEvolutionModifiers(selections, caste)`) —
  the two systems compose, neither replaces the other.
- **A Soldier's `carryCapacity: 0` is what actually prevents it from
  gathering, structurally — not a UI restriction.**
  `issueGatherCommand` returns `"wrong caste"` for a Soldier before any
  other check; this is a real `GatherCommandError` member, not a client-side
  guess. A Soldier can still be issued an attack or move command exactly
  like a Worker or Scout.
- **The player picks a caste when reproducing, never the server.**
  `POST /api/reproduce` takes `{ caste }` in the body (validated against
  the three literal strings, `400` on anything else) — authority over
  *whose* colony is spending resources still comes from the session cookie,
  exactly as every other mutating route; only the caste choice itself comes
  from the client.

### Fog of war — a client-side rendering mechanic, not a security boundary

Fog of war was built twice. The first version (shipped, then reverted
within the same stage before ever reaching production) made
`getState(colonyId)` filter `otherWorkers`/`resourceNodes`/`creatures`/
foreign `colonies` server-side through a vision check before the payload
ever left the server, and rejected a gather/attack command outright with
`"target not visible"` if the target wasn't currently in the caller's
vision. That version is **not what shipped** — it was replaced by the
design below after review concluded fog belongs to gameplay feel, not
information security, and before it ever had to be reverted out of a
deployed build.

- **The whole shared world exists and moves the same way under the fog as
  it does everywhere else — fog never changes what's real, only what's
  drawn and clickable on one player's own screen.** `getState(colonyId)`
  (`state.ts`) returns the full, unfiltered world to every colony: every
  other colony's workers and queen, every resource node, every creature,
  with no distance/vision filtering anywhere. The only privacy rule that
  predates and survives this stage is Crit 10's original one — a foreign
  colony's own resource ledger is never sent, full stop; that's an economy
  rule, not a fog rule, and is completely unrelated to vision.
- **Command authorization never depended on visibility to begin with, and
  still doesn't.** `issueMoveCommand`/`issueGatherCommand`/
  `issueAttackCommand` (`simulation.ts`) keep every existing ownership/
  caste/busy/colony-active check unchanged; there has never been a
  server-side "is this target currently visible to you" gate on any
  mutation. Server authority is total over *who can do what to which
  entity* — fog has no opinion on that, and clicking blindly into darkness
  you can't see is exactly as legitimate a command as clicking something
  lit.
- **Vision sources and the darkness they punch through are computed
  entirely in `main.ts`, not the server.** `computeOwnVisionSources()`
  builds one source per own unit — the queen (`VISION_RADIUS.queen`, 300)
  if the colony is active, else a single, smaller consolation source at the
  ruin (`DEFEATED_COLONY_VISION_RADIUS`, 150) — plus one source per living
  worker at `VISION_RADIUS[worker.caste]` (Worker/Soldier 180, Scout 400 —
  a Scout's wide vision is its whole purpose, since it can't gather or
  fight well). `isVisible(x, y, sources)` is a flat `.some()` distance
  check reused by three call sites: `draw()` (skip drawing a hidden
  resource node/creature/foreign colony/foreign worker — own units are
  never gated, always fully visible), `hitTest()` (skip a hidden
  creature/node so a click can never resolve to something that isn't
  drawn), and `drawFogOverlay()` (the actual darkening — a translucent
  rect with `destination-out` circles punched for every source, same
  circles the other two consult). All three share the one source list
  computed once per frame, so what's dark, what's drawn, and what's
  clickable can never drift out of sync with each other.
- **A blind click into darkness is just a move command, with zero special
  casing.** `onCanvasClick()` runs `hitTest()` first; when it returns
  `null` — which it now does for anything hidden, same as genuinely empty
  ground — it falls through to `onMoveClick(wx, wy)` exactly as it already
  did for empty ground before this stage existed. A unit sent into the dark
  carries its own vision circle with it and reveals whatever's there the
  moment it arrives, with no code path that needs to know the difference
  between "empty" and "hidden."
- **Why the server-side version was abandoned: it was a real, measured,
  avoidable cost with no spatial index and no measured performance budget,
  unlike every other stage's tick-cost work (Stage 3's separation grid,
  Stage 7/9's documented sub-millisecond `advanceSimulation()`
  measurements).** The old `getVisionSources(colonyId)` scanned every
  worker in the *entire world* per call, and `getState()` then re-ran a
  vision check across every foreign worker, every resource node, every
  creature, and every colony for each request — roughly
  `O(colonies × avg_workers_per_colony × total_world_entities)` once there
  are dozens of colonies live, the one subsystem in this codebase that
  scales that way. This was reproducible and measured (see `PROCESS.md`),
  not just suspected: removing it was worth roughly a 2x reduction in
  `getState()` cost at a Stage-9-precedent-shaped population, and a smaller
  but still real improvement at the live dev world's actual (differently-
  shaped) population. At that real-world shape a separate, unrelated,
  pre-existing cost (`getAllColonies()`'s per-colony population scan —
  O(colonies × workers), introduced in Stage 9, not this stage) happened to
  dominate the total more than fog filtering did — worth a follow-up
  optimization note in a later stage, but it doesn't change this stage's
  conclusion: fog filtering was real, avoidable, unbounded-with-scale cost,
  and removing it was the right call regardless of which cost was largest
  at any one measured moment.
- **No anti-cheat guarantee was ever a goal, so moving fog off the server
  costs nothing this project actually needs.** A browser devtools user can
  already see the full world state in the client-side-fog design — exactly
  as true as it would be for any other single-page game with no
  server-authoritative-rendering requirement. The brief's security surface
  is about *mutation* authority (who can move/gather/attack what — Crit
  10's session/colony model), never about withholding read-only world state
  from the same browser that's already trusted to render it.

## Stage 11: accounts, entry flow, guest persistence, reset & admin

Every stage through 10 had exactly one identity concept: a `sid` cookie
resolving straight to `sessions.colony_id` (Crit 10). Stage 11 adds durable,
cross-device accounts, a deliberate player-level Reset Progress, and a small
admin role/interface — without touching that resolution chain's core
guarantee, only extending it.

- **One extra indirection, one new resolution root.** A session row is
  either a guest (`sessions.account_id IS NULL`, `colony_id` means what it
  always has) or authenticated (`account_id` set). For an authenticated
  session the authoritative colony is `accounts.active_colony_id`, looked up
  fresh every time — never `sessions.colony_id`, which goes vestigial (never
  cleared) the instant `account_id` is set. `src/server/auth.ts`'s
  `resolveIdentity(cookieHeader)` is the one new function every `/api` route
  resolves through: it calls the existing `resolveOrCreateColony` first
  (still always mints a guest session/colony exactly as before), then reads
  through `getSessionAccountId`/`getAccountById` if one exists. A guest's
  `role`/`username`/`accountId` are `null` — never `"player"`, which would
  misleadingly imply an account exists. `getColonyForSession` (used by
  `broadcastState()`) got the same extension: `accountId == null` → return
  `sessions.colony_id` directly; otherwise look up
  `accounts.active_colony_id`. **The WebSocket connection still caches only
  `sessionId`, nothing else** — the Stage 8 lesson (never cache a value
  across a connection that can be re-pointed mid-connection) applies
  identically to the new accounts indirection, not just to colony restarts.
- **The browser never gets to declare which colony it owns — unchanged,
  extended one level deeper.** Every account/auth mutation
  (`register`/`login`/`logout`/`resetProgress` in `auth.ts`) takes
  `sessionId` from the resolved cookie and, where relevant, `accountId` from
  the already-resolved identity — never a client-supplied id. The one
  genuinely new read, `GET /api/session`, is deliberately **non-minting**:
  `peekIdentity(cookieHeader)` only parses an existing cookie and looks up
  what's already there, returning `"anonymous"` for anything that doesn't
  resolve, so a first-time visitor can be shown the entry gate without a
  colony being minted just for asking. This route is registered ahead of
  the general `/api` middleware (which still mints unconditionally for
  every other route) specifically so it can stay mint-free.
- **Guest→account conversion adopts the existing colony; it never copies or
  duplicates it.** `register()` sets the new account's
  `active_colony_id` to `getColonyForSession(sessionId) ?? claimFreshColony().colonyId`
  — if the session already owns a guest colony, that exact row becomes the
  account's colony; nothing about ownership was ever encoded on the colony
  row itself, only on whatever points at it, so there's no merge logic to
  write. Username uniqueness is enforced DB-side (`UNIQUE COLLATE NOCASE`),
  surfaced as a generic `409`.
- **Login never merges a guest colony into an existing account — the guest
  colony is orphaned, not deleted.** `login()` re-points only
  `sessions.account_id`; it never touches `accounts.active_colony_id` or any
  colony the browser's prior guest session owned. That guest colony keeps
  existing, unreferenced by this session going forward, exactly the same
  "ruin" shape a defeated colony already has (Stage 8) — just reached via a
  different path (identity switch instead of defeat). Login also never
  distinguishes "no such user" from "wrong password": both produce the
  identical `401 "invalid username or password"`, so a failed login can't
  be used to enumerate usernames.
- **Logout invalidates the session's authentication, never the account or
  its colony.** `logout()` is exactly `setSessionAccount(sessionId, null)`
  plus a log line — no colony/account row is ever touched. The client
  treats a successful logout as "return to the entry gate," not "resume
  whatever `sessions.colony_id` is still sitting there" (that column is
  vestigial for an account session, per the first point above).
- **Reset Progress reuses the existing colony-defeat/claim lifecycle —
  there is no second destructive path.** `resetProgress()` requires body
  confirmation of the exact literal `"RESET"` (`400` on anything else,
  checked before any mutation), then calls the same `defeatColony(colonyId,
  "reset")` Stage 8's abandon flow already uses (just a different `cause`
  literal) and the same `claimFreshColony()` every other "this identity now
  owns a different colony" transition uses. A guest re-points via
  `saveSession`; an authenticated session re-points via `setAccountColony`
  instead — never both, mirroring exactly how each identity's authoritative
  colony is resolved elsewhere.
- **Passwords are never stored plaintext, and never compared with `===`.**
  `src/server/password.ts` is a small, dependency-free module (no
  bcrypt/argon2 installed) built only on `node:crypto`'s `scryptSync`/
  `randomBytes`/`timingSafeEqual`. Each account stores its own random
  16-byte salt and its own scrypt cost parameters (`n/r/p`, currently
  `{n: 16384, r: 8, p: 1}`, sized for the 256MB Fly machine this app
  actually runs on — a desktop-class higher `n` risks OOM under a concurrent
  login burst) rather than a single shared constant, so a future change to
  those numbers can never invalidate an already-issued hash. Verification
  always uses `timingSafeEqual` on equal-length buffers (returning `false`,
  not throwing, on any length mismatch from a malformed/legacy hash) — never
  a plain `===`, which would leak timing information about how many leading
  bytes matched.
- **Admin role is resolved server-side only, from the same `resolveIdentity`
  every other route already calls — never from client-controlled data.**
  `requireAdmin` middleware in `index.ts` is a one-line check,
  `req.role !== "admin" → 403 {error: "forbidden"}`, sitting directly in
  front of each `/api/admin/*` route; `req.role` was already set once per
  request inside the shared `/api` middleware from a fresh DB lookup, so
  there's no second, separate trust decision for admin routes to get wrong.
  Every admin `SELECT` lists safe columns explicitly (`getAllAccounts()`
  etc.) — never `SELECT *` — so `password_hash`/`password_salt` can never
  leak into an admin response by accident, even as the schema grows later.
- **Admin accounts are provisioned by boot-time env vars, idempotently, and
  never clobber an operator's changed password.** `bootstrapAdminAccount()`
  is a no-op if `ADMIN_USERNAME`/`ADMIN_PASSWORD` are unset; if the named
  account doesn't exist it's created as `role: "admin"`; if it exists but
  isn't admin, it's promoted; if it's already an admin, its password is left
  alone on every subsequent boot/redeploy. Dev values live in
  `mise.local.toml` (gitignored) — never commit real admin credentials or
  echo them in logs.
- **`/admin` is a separate standalone page, not a view inside the game
  SPA.** `public/admin.html` + `src/client/admin.ts` are a second esbuild
  entry point with their own bootstrap: it calls `GET /api/admin/stats`
  first, and a `403` renders "Not authorized" and stops — no private data is
  ever embedded in the page's own markup or bundle for a non-admin to read
  out of devtools. `GET /admin` itself serves the HTML unconditionally (the
  real gate is every subsequent `/api/admin/*` call); the in-game "Admin"
  link is shown only when `identity.role === "admin"`, client-side
  convenience only, never the actual authorization boundary.
- **Admin "Reset World" is a capability that ships untriggered — it was
  never invoked against any real database during this stage's
  implementation, and it must only ever be triggered later, manually, by a
  human operator through the live admin UI.** The route requires body
  confirmation of the exact literal `"RESET WORLD"` (deliberately distinct
  from player Reset Progress's `"RESET"`, so the two can never be confused
  by a copy-paste) and calls the existing `resetProductionWorld()`
  in-process — the same function `scripts/reset-world.ts` already used
  safely for the one Stage 6b production reset — rather than shelling out to
  that script, avoiding a new child-process failure surface for something
  already safe and synchronous. Immediately after it commits, the handler
  force-closes every open `wss.clients` socket (`index.ts`, right after
  `resetProductionWorld()` and the `admin_reset_world` log line) — this is
  the one case in the whole app where the server proactively closes
  connections rather than waiting for the next tick's re-resolution, because
  a world reset can invalidate *every* open tab's identity simultaneously,
  not just the acting admin's own. **This stage's own test suite
  (`spec/admin-reset-world.test.ts`) enforces its own isolation discipline:
  it spawns a genuinely separate child server process against its own
  throwaway DB file and its own admin credentials, on a different port —
  the real dev and production databases are never touched by any test, and
  Reset World was not run against either during this stage's development.**
- **Client-driven reconnect, not server-forced closure, is the mechanism for
  every *other* auth transition.** Register/login/logout/Reset Progress all
  only affect the acting browser's own identity, so after each one succeeds
  the client itself closes its socket, clears ephemeral UI state (selection,
  overlays), and re-runs the same bootstrap (`GET /api/session` → entry gate
  or `enterGame()`) a fresh page load would run — there is no server-side
  force-close for these. `main.ts`'s `ws.on("close", ...)` handler
  distinguishes an intentional close (tracked via an
  `intentionallyClosedSockets` WeakSet, or a socket already superseded by a
  newer one) from an unexpected one — only the latter triggers the
  reconnect-via-bootstrap path, which is also exactly what makes Reset
  World's server-forced closures self-heal on every affected tab with no
  special-case client code: they arrive at the same handler as any other
  unexpected close.
- **Existing mutating routes needed zero changes for ownership to keep
  working post-accounts.** `/api/state`, `/api/reproduce`, `/api/abandon`,
  `/api/start-new-colony`, `/api/evolve`, `/api/command/*` all still read
  only `req.colonyId`, populated by the same session middleware as always —
  the account layer is invisible to them by construction, the same way
  Crit 10's authorization model was already invisible to `actions.ts`/
  `simulation.ts` internals.
- **No new runtime dependencies.** No bcrypt/argon2, no express-session, no
  cookie-parser, no passport — `node:crypto` and the existing hand-rolled
  cookie/session code (`sessions.ts`) cover everything this stage needed.
- **Explicitly out of scope, same as the brief:** no email, no password
  reset flow, no OAuth/SSO, no multi-admin roles beyond the single `admin`
  role, no account deletion, no guest-to-account auto-merge on login, no
  rate limiting on auth routes, no CAPTCHA.

## Stage 12: persistent world ecology, regeneration & finite resources

Every stage through 11 left the world's resources/creatures as a one-time
seed (Stage 6b) that only ever depletes — nothing replaces a fully-gathered
node or a hunted-out aphid/spider population, and a defeated colony's ruin
blocks its ground forever. Stage 12 adds a lightweight ecology layer that
keeps the world alive over a long-lived shared session, and closes a
pre-existing economy gap (truly infinite resources) along the way. This is
explicitly economy-pressure/world-liveliness work, not a new gameplay
system: no queen movement, no buildings, no hatching, no PvP, no breeding/
genetics, no new species or resource types, no seasons/weather/territory
simulation.

- **Ecology state is pure in-memory/derived — no new DB table, and zone
  membership is computed, not stored.** `src/server/ecology.ts` recomputes
  every zone's density from scratch each evaluation tick, reading the same
  authoritative sources `getState()` already reads (resource nodes,
  `creatures` Map). Per-zone depletion-deadline state lives in a plain
  in-memory `Map`, lost on restart — accepted the same way as Stage 5's "no
  catch-up regen on boot": this is timing noise, not economic state.
- **Zones reuse Stage 6b's own shape instead of a uniform grid, because a
  uniform grid would split an anchor cluster across a cell boundary.** 10
  anchor zones (`ECOLOGY_ANCHOR_ZONE_RADIUS = 300`) are centered at
  `colonySpiralPosition(i)` for `i = 0..SPAWN_ANCHOR_COUNT-1` — the exact
  same deterministic function Stage 6b's generation and `createColony()`'s
  spawn placement already use, so there's nothing new to store. Everywhere
  else falls into a `300x300` background grid (`ECOLOGY_BACKGROUND_CELL_SIZE`),
  with a cell only counting as its own zone if its *center* lies outside
  every anchor's radius — giving every point in the world exactly one zone
  membership via the pure function `zoneForPosition(x, y)`, with no
  double-counting and no boundary ambiguity.
- **Density is a weighted sum of exactly 5 ecology-eligible types; player-
  owned entities (workers, queens) contribute zero.**
  `ECOLOGY_DENSITY_WEIGHTS = {sugar:1, biomass:1.5, protein:2, aphid:2,
  spider:5}` (`balance.ts`). Anchor zones target `ECOLOGY_ANCHOR_TARGET_DENSITY
  = 15` (matching what one Stage-6b anchor originally held) and background
  cells target `ECOLOGY_BACKGROUND_TARGET_DENSITY = 1` (matching the
  original scatter density) — two tiers, not bespoke per-zone numbers, by
  design. This keeps the world's steady-state population the same order of
  magnitude as Stage 6b's original seed, not several times denser.
- **Regeneration requires continuous depletion past a randomized deadline,
  not a one-time dip — this is what prevents flicker right at the
  threshold.** A zone that drops below target starts a pending deadline
  (`random(ECOLOGY_REGEN_DEADLINE_MIN_MS=15_000, ECOLOGY_REGEN_DEADLINE_MAX_MS=60_000)`
  out); recovering above target before the deadline clears it with no
  spawn. A deadline that elapses while still below target spawns exactly
  one entity and immediately gets a fresh randomized deadline, so a
  persistently-depleted zone keeps trying every 15-60s rather than firing
  once. All of this is driven by one shared `ECOLOGY_EVAL_INTERVAL_MS =
  5000` `setInterval` in `index.ts` — deliberately its own timer, decoupled
  from `SIMULATION.tickHz`/`broadcastHz`, a single `O(resourceNodes +
  creatures)` pass every 5s rather than a per-tick scan (Stage 10's
  documented anti-pattern for exactly this shape of cost).
- **Which of the 5 types spawns is scarcity-weighted, with a strong enough
  boost to matter next to abundance.** `weight = baseShare × (1 +
  SCARCITY_BOOST_FACTOR × max(0, 1 − currentCount/expectedCount))`, with
  `SCARCITY_BOOST_FACTOR = 8` — modeling during design showed a lower
  factor (3) was too weak to make a zone with zero protein meaningfully
  more likely to spawn protein next to abundant sugar. A type at or above
  its expected share still keeps a nonzero floor weight (`baseShare`), so
  nothing is ever fully excluded from a weighted draw.
- **`MAX_ECOLOGY_ENTITIES = 300` is a raw-entity count, not a weighted
  density sum — a global emergency backstop, not a target ecology is meant
  to brush up against.** Derived from the per-tier raw mix (≈95 anchor +
  ≈90 background + ≈10 spider ≈ 195 raw entities at full provisioning,
  ~160 as the conservative typical figure), `300` sits at roughly 1.5-1.9x
  that range. Checked once per evaluation tick via a plain live count
  (sugar+biomass+protein nodes with `kind='source'`, plus aphid/spider
  creatures) before any spawn is attempted; at or over the cap, no spawns
  happen that tick regardless of per-zone eligibility.
- **Active queens and non-expired ruins both exert spatial exclusion on
  ecology placement, via the same `isRuinExpired` gate that controls ruin
  visibility — a visible ruin is still occupying that ground exactly as
  long as it's drawn on screen.** `ECOLOGY_QUEEN_EXCLUSION_RADIUS = 250`
  from every colony that is either `status === 'active'` or
  `status === 'defeated' && !isRuinExpired(defeatedAt)`. This deliberately
  does **not** reuse `isClearOfNests`'s "active only" precedent — that
  precedent answers "can a spider aggro here," where an inert ruin poses no
  threat; ecology exclusion answers "is this ground currently disturbed,"
  where a spawning resource node directly on top of a still-visible ruin
  would read as broken. The instant `isRuinExpired()` flips true, the ruin
  loses both live-game visibility and ecology exclusion in the same tick —
  there is no window where one lags the other, because both read the same
  `defeated_at` column through the same function.
- **A zone partly covered by an exclusion circle has its effective target
  reduced proportionally, not an all-or-nothing block.** `effectiveTarget =
  target × (1 − overlapAreaFraction)`, via standard circle-circle
  intersection area between the zone's own circle (or an equal-area circle
  approximation for a background cell) and the exclusion circle. This stops
  a zone mostly inside a thriving colony's exclusion ring from endlessly
  reporting "eligible to spawn" while every placement attempt fails — it
  simply expects less of itself.
- **The infinite-resource path (`amount: null`) is gone — this is now a
  global invariant, not scoped to ecology-spawned entities.** Investigation
  found the path was already almost entirely vestigial in production
  (every seeded constant was already finite; the only code that ever
  created a null-amount node was two `spec/simulation.test.ts` fixtures,
  neither of which actually asserted infinite-ness). `findResourceNode()`'s
  return type narrowed to `amount: number`; the one line that actually
  implemented "infinite" at runtime —
  `claimedAmount = node.amount === null ? carryYield : Math.min(carryYield, node.amount)`
  — is now unconditionally `Math.min(carryYield, node.amount)`, so no claim
  can ever exceed what's actually left on a node, regardless of whether
  that node came from Stage 6b's seed or ecology regen. A generalized,
  idempotent boot-time migration (extending `migrateSugarNodesFinite()`'s
  existing pattern to every `resource_type`) backfills any legacy
  null-amount row in a deployed DB to that type's finite default. The
  schema column itself stays nullable (SQLite can't retroactively add
  `NOT NULL`) — the invariant is enforced by the migration plus application
  code, the same established pattern as every other backfill in this
  codebase.
- **Queen ruin lifetime (`RUIN_LIFETIME_MS = 600_000`, 10 minutes) closed a
  real pre-existing gap: `getState()` and `buildSpawnAvoidance()` had no
  access to `defeated_at` at all.** Both now select `defeated_at` and
  filter out any colony where `status === 'defeated' &&
  isRuinExpired(defeatedAt)` before returning — an expired ruin disappears
  from the live game view and stops blocking a new colony's spawn.
  `isRuinExpired(defeatedAtIso, nowMs = Date.now())` takes an optional,
  injectable `nowMs` so tests can assert the exact expiry transition
  without manipulating the wall clock; every production call site omits it
  and gets the real clock. `getAllColonies()` (admin) stays completely
  unfiltered, by design — only a ruin's *visibility in the live game world
  and its spawn/ecology-blocking effect* expire, never the record itself
  (same "ruins retain history forever" rule Stage 9 already established for
  evolution).
- **Admin ecology visibility is read-only and computed on demand, never
  stored.** `GET /api/admin/ecology` (behind the existing `requireAdmin`
  middleware) returns one row per anchor zone (density, target, pending-
  regen countdown) plus one aggregate row for the background grid (zone
  count, average density, pending count). `public/admin.html` /
  `src/client/admin.ts` render it as one more plain `<table>` section,
  following the page's existing per-section pattern (typed interface,
  `escapeHtml()`, fetched alongside the other sections in `loadAll()`'s
  `Promise.all`) — no charts, no new visual idiom.
- **Performance was measured, not assumed, at both a normal and a stress
  population.** A throwaway script (not committed) seeded an isolated test
  DB with ~180 raw entities (within the plan's derived 160-195 normal
  steady-state range) and separately with 300 (at `MAX_ECOLOGY_ENTITIES`),
  kept every zone perpetually past its regen deadline so every tick does
  real scarcity-weighted selection and placement-retry work, and measured
  `advanceEcology()` over 500 ticks: **~0.153ms/tick average at the normal
  population (~32,765x headroom)** and **~0.178ms/tick average at the
  stress population (~28,070x headroom)** under the 5000ms
  `ECOLOGY_EVAL_INTERVAL_MS` budget. Confirms this is trivial at this
  game's scale, consistent with Stage 7/9's own sub-millisecond
  `advanceSimulation()` precedent — revisit only if either population grows
  by orders of magnitude.
- **`spec/ecology.test.ts` follows the direct-module-import pattern Stage
  1b/4 established**, with its own throwaway `DB_PATH` override
  (`./.data/colony.ecology-test.db`), a seeded `mulberry32` PRNG for the
  scarcity-weighting statistical test, and `setEcologyRng`/
  `resetEcologyState` test-only hooks mirroring `resetForTests()`'s
  convention elsewhere.
- **Explicitly out of scope, same as the brief:** no queen movement, no
  buildings, no hatching, no PvP, no breeding/genetics, no new species or
  resource types, no seasons/weather/territory simulation. The one
  deliberate reversal from the original non-goals list: the global
  infinite-node removal above was added mid-design after review found the
  original ecology-scoped version left a contradiction in place.

### Stage 12 addendum: global population scarcity (rarity x local x global)

Added after the first Stage 12 implementation shipped and a real spider
extinction was observed in the live shared dev world: `ANCHOR_BASE_SHARE.spider`
and `BACKGROUND_BASE_SHARE.spider` were both `0` (spiders are seeded
independently of the anchor/scatter mix — see `buildWorldPopulation()`), and
`pickSpawnType()`'s old `if (share <= 0) continue` guard meant spiders could
**never** be selected by ecology regeneration, regardless of how depleted the
world was. A globally rare species could be hunted to extinction with no path
back. This addendum fixes that by adding a second, independent factor to
**WHAT** gets selected — it does not change, duplicate, or add a second
trigger for **WHEN** regeneration happens, which remains entirely the
existing per-zone continuous-depletion-plus-randomized-deadline logic in
`advanceEcology()`.

- **New selection model**: for each of the 5 ecology types,
  `score_i = rarity_i x localScarcity_i x globalScarcity_i`, normalized into
  a probability distribution and drawn from with the same seeded
  `pendingRng()` hook as before. `localScarcity_i` is exactly the old
  per-zone-tier scarcity multiplier (`1 + SCARCITY_BOOST_FACTOR x
  max(0, 1 - count/expected)`), computed from `ANCHOR_BASE_SHARE`/
  `BACKGROUND_BASE_SHARE` exactly as before — those two maps no longer
  double as a candidate-inclusion gate, only as the local-scarcity baseline.
  For a (type, tier) pair with no local expectation at all (`share <= 0` —
  spiders are deliberately never anchor-clustered), `localScarcity` is
  neutral (`1x`): there's no local baseline for that type to be "scarce"
  against, so rarity and global scarcity alone decide its odds there. Every
  type is now always a selection candidate.
- **Rarity ranks** (`balance.ts`'s `RARITY_BASE_WEIGHT`/`ECOLOGY_TYPE_RARITY`)
  generalize the existing base-weight idea into one shared, zone-tier-
  independent global weight per type: Common=1.00 (sugar), Uncommon=0.55
  (biomass, aphid), Rare=0.25 (protein), Extremely Rare=0.08 (spider).
- **Global scarcity** (`balance.ts`'s `REFERENCE_WORLD_AREA`,
  `REFERENCE_DESIRED_POPULATION`, `GLOBAL_SCARCITY_K=4`,
  `GLOBAL_SCARCITY_MAX_MULTIPLIER=50`; `ecology.ts`'s
  `computeWorldScale()`/`desiredPopulationFor()`/`globalScarcityMultiplier()`/
  `computeGlobalPopulation()`) scales desired population by world size so no
  absolute population target is ever hardcoded:
  `worldScale = worldArea / REFERENCE_WORLD_AREA`,
  `desiredPopulation_i = referenceDesiredPopulation_i x worldScale`. The
  current 3000x3000 `WORLD` is also the reference world for now
  (`worldScale = 1` today), but the two constants are independent so a
  future larger world scales proportionally without code changes.
  `populationRatio_i = currentGlobalPopulation_i / desiredPopulation_i`,
  `deficiency_i = max(0, 1 - populationRatio_i)`,
  `globalScarcity_i = min(G_MAX, exp(K x deficiency_i^2))`. At or above the
  desired population the multiplier is exactly 1 (no bonus for abundance,
  no penalty either). Verified curve: ratio 1 -> 1x, 0.75 -> ~1.28x,
  0.5 -> ~2.72x, 0.25 -> ~9.49x, 0.1 -> ~25.5x, extinct (0) -> capped at
  exactly 50 (uncapped would be e^4 ~= 54.6) — mild underpopulation barely
  moves spawn odds, severe depletion increasingly overrides normal rarity,
  and a fully extinct type gets strong, bounded recovery pressure.
- **Reference desired populations** (`REFERENCE_DESIRED_POPULATION`) are
  Stage 6b's own original seeded totals, not invented numbers: sugar=36
  (`SUGAR_PER_ANCHOR x SPAWN_ANCHOR_COUNT + SCATTER_SUGAR_COUNT`), biomass=28,
  protein=8, aphid=52, spider=10 (`SPIDER_COUNT`) — matching the Stage 12
  plan's own "~36 sugar + 28 biomass + 8 protein + 52 aphid + 10 spider"
  figure. This is balancing configuration, not an architectural constant
  scattered through the code — one record in `balance.ts`.
- **Desired populations are ecological targets/densities, never hard caps.**
  A type above its desired population is never deleted or suppressed beyond
  its multiplier returning to the neutral `1x` floor — overpopulation is
  never penalized. `MAX_ECOLOGY_ENTITIES = 300` remains the only hard,
  *technical* safety cap (raw entity count, checked once per tick before any
  spawn), completely independent of and unaffected by global scarcity: the
  cap still suppresses every spawn once reached, even for a fully extinct
  Extremely Rare type under maximum (50x) global pressure. As the world or
  its capacity grows, `MAX_ECOLOGY_ENTITIES` will need to scale too (likely
  alongside `REFERENCE_WORLD_AREA`'s `worldScale`), but that is future work —
  it stays a fixed `300` for this stage.
- **Apex predator is explicitly future design only — not implemented in
  Stage 12.** A possible future concept (one persistent living instance per
  apex species, a fixed lair, alive -> killed -> finite carcass -> expiry ->
  cooldown -> respawn at its lair; a future, larger world might support
  multiple apex species) is recorded here purely as a non-goal for this
  stage, not as a spec to build against.
- **Live dev-world observation attempted, but the apparent recovery turned
  out to be a false positive — correcting an earlier, wrong finding.**
  Before this addendum, the shared dev world (`./.data/colony.db`) held
  exactly 0 live spiders. After the code changes, read-only inspection
  showed the spider count at exactly 10. That was initially (and
  incorrectly) reported as organic, ecology-driven recovery. Closer
  inspection before finalizing this report disproved it: all 10 rows share
  one identical `created_at` timestamp, and their `(x, y)` positions are an
  exact, order-for-order match for `SPIDER_SEED_POSITIONS` — the original
  Stage 6b/7 scatter seed, not a scarcity-weighted ecology spawn (which
  would stagger timestamps one zone at a time, 15-60s apart, at essentially
  arbitrary positions). The real explanation: `src/server/db.ts` has a
  pre-existing, unconditional, module-level `seedSpidersIfMissing()`
  migration (line ~218, dating to Stage 7, independent of this addendum)
  that bulk-inserts the entire original seed list the moment any process
  imports `db.ts` against a DB with zero spiders. A separate, stale
  `node --watch` dev process (not the one actually serving port 8080) was
  still running from an earlier session pointed at the same live DB path;
  editing `balance.ts`/`ecology.ts` during this work triggered its
  auto-restart, which re-ran `db.ts`'s module-level seed migration and
  produced the bulk insert — then that process failed to bind to the
  already-occupied port and sat idle. This has nothing to do with the new
  global-scarcity code. Worse, the dev server actually serving port 8080
  (confirmed via `lsof`) was started hours **before** this addendum's code
  edits and was not using `--watch`, so it is almost certainly still
  running the pre-addendum ecology code — meaning the new model has not
  yet been exercised against the live dev world at all. **No genuine
  observation of ecology-driven spider recovery has been made.** This
  needs a deliberate server restart (not performed here, since restarting
  the process that's actively serving the shared dev world wasn't itself
  part of the original ask) before that observation can be attempted for
  real.
- **12 new deterministic tests added to `spec/ecology.test.ts`** (29 total,
  up from 17), covering: multiplier=1 at/above desired population; modest
  increase under mild depletion; much larger increase under severe
  depletion; capped maximum pressure at zero population; proportional
  desired-population scaling with world area; an extinct Extremely Rare
  type's score outweighing a healthy Common type's; a recovered rare type's
  multiplier falling back to the 1x baseline; `computeGlobalPopulation`'s
  raw world-wide counts; an oversupplied type never being deleted; the
  global entity cap still suppressing spawns under maximum scarcity
  pressure; local scarcity still biasing selection between two equally-rare
  types; and a fixed RNG override producing fully deterministic, non-flaky
  selection. All 17 pre-existing Stage 12 tests continue to pass unchanged.

### Stage 12 fix: the legacy spider seeder could undo a real in-game extinction

The false-positive "organic recovery" investigation above surfaced a real
architectural bug, independent of the new global-scarcity code: `db.ts`'s
Stage-7-era `seedSpidersIfMissing()` gated itself on a **live** count
(`SELECT COUNT(*) FROM creatures WHERE species = 'spider'`), re-run
unconditionally on every process boot. That count can't distinguish "this
world predates spiders entirely" from "this world's spiders were
legitimately hunted to extinction by players or Stage 12 ecology" — both
look identical (zero). So any ordinary server restart that happened to land
while a world's spider population was at zero would silently bulk-insert
the entire original `SPIDER_SEED_POSITIONS` list again, undoing real
gameplay/ecology state. This is exactly the mechanism that produced the
false "recovery" signal above, just triggered early (by a stale `--watch`
process) rather than by an intended restart.

**The fix:** replace the live-count gate with a durable, one-time marker.
`worlds` gained a `creatures_seeded INTEGER NOT NULL DEFAULT 0` column
(schema default for fresh DBs; `migrateWorldsCreaturesSeeded()` ALTERs it
onto an existing DB, mirroring `migrateWorkerCaste()`'s guarded-ALTER
pattern elsewhere in this file). `seedCreaturesIfEmpty()` now does
everything both old functions did, in one pass, gated on
`WHERE creatures_seeded = 0`: for each not-yet-seeded world, insert every
species in `SPECIES_SEED_POSITIONS` (aphid and spider together, exactly as
before), then mark that world `creatures_seeded = 1` — permanently. Once a
world is marked, no later boot ever seeds it again, no matter how its
creature counts fluctuate. `seedSpidersIfMissing()` is deleted entirely;
its old job (topping up a pre-Stage-7 world that has aphids but no
spiders) is now just the normal case of a not-yet-seeded world getting
every species at once.

The one subtlety is classifying **already-existing** worlds the first time
this migration runs: a world with living creatures right now is obviously
already seeded (`backfillWorldsCreaturesSeeded()` marks it immediately,
via `EXISTS (SELECT 1 FROM creatures WHERE world_id = ...)`), but a world
that happens to have **zero** creatures at that exact moment is genuinely
ambiguous — it could be a legacy pre-seed world, or a world that was
already extinct before this fix shipped. Both are left unmarked and get
one honest pass through `seedCreaturesIfEmpty()`, same as a brand-new
world — this is the one case where the fix can't distinguish "never
seeded" from "already extinct" either, but it only ever applies once, at
the moment this migration first runs on a given DB file, never again on
any later restart. Every world is unambiguous from that point forward.

This required no change to `resetForTests()` or `resetProductionWorld()`
— both already wipe the entire `worlds` table and call `seedIfEmpty()`,
which inserts a fresh row with `creatures_seeded` defaulting to 0, so
`seedCreaturesIfEmpty()` still seeds a reset/fresh world exactly as
before. No production data was touched to make this fix; it only changes
what *future* restarts do.

**Checked for the same conflict elsewhere:** `seedCreaturesIfEmpty()`
itself used to gate on the entire `creatures` table being empty — in
principle, if *every* creature (not just spiders) in a world were ever
driven to zero at once, a restart could have re-seeded everything, the
same bug in a wider blast radius. The new per-world `creatures_seeded`
marker closes this too, since the fix isn't per-species — it's "has this
world's initial population ever been established," checked once, covering
every current and future entry in `SPECIES_SEED_POSITIONS` uniformly. No
other `seedXIfMissing()`/`seedXIfEmpty()`-style function in `db.ts` reads a
live population count as its gate — `seedIfEmpty()` gates on `colonies`
count, which is a fundamentally different, session-driven concept (a new
colony is explicitly minted by a player via `createColony()`, never
something ecology silently depletes), so it carries no analogous risk.

A new test-only export, `runBootSeedSequenceForTests()`, re-runs exactly
the boot-time seed/migration calls a real restart would (`seedIfEmpty()`,
`backfillWorldsCreaturesSeeded()`, `seedCreaturesIfEmpty()`) against
whatever state the DB is already in, without wiping any table — this is
what let the new regression tests simulate "the server restarts while an
existing, already-initialized world has zero spiders right now" without
faking a fresh ESM module import (re-importing an already-loaded module
path is a cache hit, not a re-run of its top-level code, so simulating a
restart needs an explicit re-invocation of the boot sequence instead).
Three new tests were added to `spec/ecology.test.ts` (32 total, up from
29): an existing world with zero spiders stays at zero across repeated
simulated restarts; the same holds when *every* creature in a world has
gone extinct, not just spiders; and a brand-new world still receives its
full intended population on the very next boot pass, seeded exactly once
even if the boot sequence runs again immediately after. All three pass
deterministically against an isolated test DB — no destructive action was
taken against the shared dev DB to reproduce the extinction scenario
manually; the invariant is proven mathematically against isolated state
instead (see below).

