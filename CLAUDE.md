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
