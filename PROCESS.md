# Process overview

## Stage 6b: playtest world reset, population, and player guidance

Crit 10 made multiplayer real, but the deployed world was still whatever
Stage 1–6 had left behind after months of iteration and manual testing: a
single hand-placed 12-node/14-aphid layout, a handful of accumulated test
colonies with mutated resource counts, and no in-game explanation of any of
it for a first-time visitor. This stage's bar, from the brief, was explicit
that it is *not* a new gameplay-system stage — no predators, PvP, worker
death, respawning, evolution, or buildings — just a one-time reset, denser
deterministic world content, and player guidance, with every Crit 10
multiplayer invariant held fixed.

I started from the two load-bearing constraints rather than the feature
list: the reset mechanism had to be a deliberate, intentionally-invoked
operation (never automatic on boot/deploy, never an HTTP endpoint a visitor
could hit), and the new world content had to still make every spawn
location in the multi-colony architecture viable, not just the original
single-colony center. Both of those shaped the implementation before any
code was written.

([`7fd93c4`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/7fd93c4))
replaces the hand-typed resource/aphid arrays with `buildWorldPopulation()`
in `balance.ts`: a `mulberry32` PRNG seeded with a fixed literal constant
(never `Math.random()`/`Date.now()`, so a fresh deploy and a test run
produce byte-identical coordinates) clusters sugar/biomass/protein/aphids
around each of the first 10 colony-spiral spawn points — the exact same
`colonySpiralPosition()` function `createColony()` already used, factored
out so "likely colony spawn" and "has nearby content" can't drift apart —
plus a smaller scatter across the whole map so exploring away from any one
colony still finds things. The same commit adds `resetProductionWorld()` in
`db.ts` and its CLI wrapper, `scripts/reset-world.ts`, which refuses to do
anything without a literal `--yes` flag and is never imported from
`index.ts`, so no boot path or route can trigger it. I chose to preserve
`action_log` across this reset rather than wipe it along with everything
else: Crit 10 built that log specifically for accountability, and erasing
it at the one moment it would most need to show "what happened right before
the reset" would undercut its own purpose. `resetForTests()` keeps wiping it
for tests, which have no accountability need and want a genuinely blank
slate — a deliberate difference between the two functions, documented at
both call sites.

Fair starting protein was the one piece of Section 5 that needed an actual
balance decision rather than just generation: `STARTING_PROTEIN =
REPRODUCE_COST` gives every fresh colony — the original seeded one and any
Crit-10 mint alike, via a shared `seedColonyResources()`/
`spawnStartingWorkers()` pair — exactly one reproduction's worth on arrival,
enough to exercise the full loop immediately without a hunt-and-carry round
trip first, and deliberately not more than that.

Existing specs needed small, honest adaptations rather than loosened
assertions: `colony.test.ts`/`simulation.test.ts`
([`7fcb34f`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/7fcb34f))
now expect `STARTING_PROTEIN` instead of 0 on a fresh colony, and one
existing busy-worker test gained an explicit settle-any-stale-command step
on its "free" candidate — a real race the faster path to 50 protein made
newly visible, not a workaround for a flaky assertion. The same commit adds
`spec/world.test.ts`, a dedicated suite for this stage: exact
formula-derived and seed-pinned counts, every spawn anchor having its own
nearby content with nothing dropped on the anchor itself, starting state for
both the seeded and a freshly minted colony, map-wide distribution, the
reset mechanism verified at both the function level (dirtied sessions/
colonies/resources, `action_log` untouched) and via a real subprocess
invocation of `scripts/reset-world.ts` to prove the `--yes` gate is
load-bearing and not just a documented convention, the simulation layer
actually loading every seeded aphid, and a `jsdom`-based (no headless
browser) check that the served page carries the Help markup — following
`spec/invariants.test.ts`'s existing lightweight-HTTP-plus-DOM pattern
rather than introducing a new testing dependency.

The in-game guidance itself
([`42c042d`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/42c042d))
is a "How to play" button that opens an overlay documenting the game as it
actually renders — I read `main.ts` and `index.html` first rather than
writing generic genre boilerplate, so the legend's colours/shapes and the
quick start's steps match the real client exactly. It never touches `state`
or issues a command, so it's safe to open at any point mid-drag or
mid-selection with zero interaction risk.

Documentation
([`bd83beb`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/bd83beb))
closed the loop: `CLAUDE.md` gained this stage's invariants (why
`SPAWN_ANCHOR_COUNT` is exactly 10 — it has to cover every colony index the
spec suite claims, from `colony.test.ts`'s index 0 through
`multiplayer.test.ts`'s and `realtime.test.ts`'s indices — the reset's
preserve/clear boundary, and the Help overlay's role as the primary
player-facing guide, not this file or the README), and `README.md` was
rewritten wholesale: it no longer describes the Crit 8/9 10x10-grid demo,
but the actual continuous multi-colony world, travel/carry/deposit
gathering, hunting and carcasses, and real session-based multiplayer, while
keeping the "what good means here" framing and its three cited sources —
now with a note that the "shared means more than co-presence" claim is
something a second browser tab can actually go verify, not just a forward
intention.

With everything above green (`pnpm check`, `pnpm check:evidence`), pushed,
and CI's `check`+`deploy` jobs both passing, I found one more thing before
touching production: `scripts/` was never copied into the Docker image, so
the reset script that exists in the repo wouldn't exist on the deployed
machine.
([`af3640a`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/af3640a))
is the one-line Dockerfile fix (`COPY scripts ./scripts`); a second green
CI/deploy cycle shipped it.

I then ran the one authorized production reset over `flyctl ssh console`
(`node scripts/reset-world.ts --yes` against the live machine, `/data`
auto-detected as `DB_PATH` exactly as it does locally with `./.data`),
first confirming the `--yes` gate still refused without it. The script
reported `{colonies:1, workers:3, resourceNodes:72, creatures:52,
sessionsCleared:5, actionLogPreservedRows:6}` — the seeded colony's exact
starting numbers, `resourceNodes` matching the generator's formula-derived
36+28+8, and `action_log` preserved rather than cleared.

Querying `/api/state` right after, though, showed a colony with 20+ workers
and only 13 creatures — not the reset's own numbers. The live app process
had been running the whole time the reset script (a separate, short-lived
process) rewrote the DB underneath it: `loadSimulation()` only loads
workers/creatures into memory once, at startup, so the already-running
server kept serving its stale pre-reset state, and its 5-second
`checkpointSimulation()` interval was writing that stale state's positions
back over the freshly-reseeded rows wherever an id happened to collide
(these tables aren't `AUTOINCREMENT`, so SQLite reuses small ids right
away). A `flyctl machine restart` fixed it immediately — direct SQLite
queries confirmed the underlying data had been correct all along, only the
live process's view of it was stale — and `/api/state` then reported
exactly the reset's own counts. I added the same explanation to
`scripts/reset-world.ts`'s own success output and to `CLAUDE.md`, so this
isn't a trap for whoever runs this script next.

Final verification against production: an existing session cookie still
resolved to the same colony across that restart (so the restart itself
doesn't reset anything, and a reset doesn't orphan an existing session); a
brand-new session claimed a different, pre-minted spare colony with its own
nearby resources and could only see/command its own 3 workers while still
seeing every other colony's queen; a real gather command sent a worker to
travel to a node, claim sugar, walk home, and deposit it (colony sugar
0 → 10); and `/api/log` kept appending new rows (`colony_claimed`, `gather`)
after the reset on top of the preserved pre-reset history. Exactly one
production reset was run, not repeated during debugging, per the brief's
explicit constraint on that step.

## Crit 10: real multiplayer — sessions, ownership, and an audit log

Crit 10's bar: two cookie-isolated browser sessions each get their own
persistent colony in one shared world, the server derives ownership from
session identity rather than trusting anything the client sends, a session
can't command another's workers, and every action lands in a durable,
queryable, server-side log. Crit 8/9's single global colony is still the
substrate underneath — this is the first crit that actually makes more than
one colony exist at once.

I started, as with Crit 9, by writing the spec before the implementation:
`spec/multiplayer.test.ts`
([`e8fb85a`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/e8fb85a)),
four tests, red by construction — distinct persistent colonies per session,
a shared world/roster visible to both, a rejected cross-owner command with
no side effect, and a durable, API-exposed log entry attributing an action
to the acting colony. I treated this file as fixed from that point on: the
brief was explicit that it, and the other black-box HTTP spec files, were
allowed to gain a persistent-cookie helper to keep testing one consistent
browser profile per file, but never to have their actual assertions
loosened to fit whatever I happened to build.

The implementation
([`7c00c6e`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/7c00c6e),
[`2b88996`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/2b88996))
turns an anonymous `sid` cookie into a durable colony id via a new SQLite
`sessions` table, places each freshly minted colony on the same
golden-angle spiral the group-move code already used, and threads that
resolved colony id — never anything from the request body — through
`issueMoveCommand`/`issueGatherCommand`/`issueAttackCommand` so a
wrong-owner worker id fails exactly like a nonexistent one. A new
`action_log` table plus a concise stdout line back `GET /api/log`.

Two of the four red tests exposed real design gaps rather than just bugs,
each recorded in detail in `CLAUDE.md`'s Crit 10 section: the shared-world
test required pre-minting one spare unclaimed colony so a session's own
response already lists the colony the *next* joiner is about to get
(impossible under naive lazy creation, since that colony genuinely doesn't
exist yet at the moment the first session's request is served); and the
WebSocket broadcast-identity test required moving `getState()` computation
from once-per-client back to once-per-colony-per-tick, matching the
pre-Crit-10 single-shared-payload guarantee the naive per-connection
redesign had silently dropped.

Test adaptation
([`880872f`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/880872f))
gave `colony.test.ts`/`realtime.test.ts` their own small persistent-cookie
wrapper each (duplicated, not shared or imported from
`spec/multiplayer.test.ts`, which stays untouched) and updated
`simulation.test.ts`'s 77 direct `issue*Command` call sites to pass the one
colony id it already captures — all 84 tests (80 carried-forward + 4 new)
pass.

## Crit 9: realtime, and the concurrency decision

Crit 9's bar is the brief's own line: real-time within about a second with no
reload, plus one decision about multi-user behaviour, written down and
justified against this repo's own definition of good. The prototype
underneath — one global colony, gather, reproduce, SQLite persistence — is
Crit 8's, carried forward rather than rebuilt; this section covers what's new
on top of it.

I treated the mechanical half of the brief as an addition to the existing
contract, not a parallel one. A `WebSocketServer` attaches to the same
`http.Server` Express already creates, at `/ws`. After `gather` or
`reproduce` succeeds, the server reads the resulting state once and
broadcasts that exact `GET /api/state` shape to every open connection.
`CLAUDE.md`'s existing rule — the client only ever renders server state,
never computes or merges a result itself — is what kept this additive
instead of a client-side rewrite: the client just gained a second way to
receive the same shape it already knew how to render.

Before writing any server code I wrote the contract into `CLAUDE.md` and
turned it into a spec test, `spec/realtime.test.ts`, starting red by design:
one test that a single connection receives the pushed state after a gather,
one that every open connection receives it (not just the one that caused the
change), and a third test that doesn't touch WebSockets at all — two
simultaneous `reproduce` calls racing for the same protein, asserting
exactly one succeeds. That third test exists to pin down, as a real
regression test rather than a claim, the architectural fact the next
section's decision turns on.
([`e799d31`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/e799d31))

Landing a second spec file that mutates the same shared colony as
`spec/colony.test.ts` also surfaced a real test-infrastructure bug worth
recording: Vitest's default file ordering is a cache/size heuristic, not
alphabetical, so the new file could run before `colony.test.ts`'s
pristine-seed assertion and make it flaky depending on cache state — not a
one-off, I saw it fail and re-traced it to the sequencer source rather than
guessing. Fixed with a small path-ordered custom `TestSequencer` in
`vitest.config.ts`, confirmed by re-running `pnpm check` against a freshly
reseeded server until the ordering held regardless of cache state, not just
once.

[`9a13f01`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/9a13f01)
wires the server side: the WebSocket server and the broadcast call after
each successful mutation.
[`7982658`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/7982658)
wires the client: one `/ws` connection opened after the initial fetch,
re-rendering on every message — no polling added, since there wasn't any to
begin with. Both previously-red tests went green without weakening either
assertion.

## Architecture decision: concurrent mutations

Crit 9 requires one decision about what happens when more than one person
uses the app at once, justified against `README.md`'s own definition of
good. The case that actually arises here is the shared global colony: two
people can click gather or reproduce in the same second.

**Decision.** Concurrent mutations are resolved by the single authoritative
Node server, not by the clients. Each mutation (`gather`, `reproduce` in
`src/server/actions.ts`) reads the latest persisted colony state and
finishes its state-changing work synchronously, with no `await` between the
read and the write — so Express can never interleave two mutating requests
against the one global colony, and one request's effects always land in
full before the next request's logic runs. After a successful mutation, the
server reads the resulting authoritative state once and broadcasts that
exact state to every open WebSocket connection. Clients render whatever the
server sends; they never resolve a conflict or guess at an outcome
themselves.

I verified the case that actually matters, rather than just reasoning about
it: two simultaneous `POST /api/reproduce` requests racing for exactly
enough protein for one reproduction always resolve to one success and one
rejection, never two successes (`spec/realtime.test.ts`).

**Why this fits this project.** `README.md`'s definition of good says
multiplayer should make actions mutually consequential, not just put two
people in the same room — so the one outcome that can't be allowed is two
players' actions producing two different "true" states of the colony. A
single authoritative server every client defers to is the simplest way to
guarantee that, and it costs nothing extra here: the server is already a
single process and every database call in `actions.ts` is already
synchronous, so correctness falls out of the existing architecture instead
of being bolted on.

**Alternatives considered.**

- *Client-side or optimistic conflict resolution* — rejected: clients could
  temporarily disagree about the shared world's actual state, which is
  exactly the failure this decision exists to rule out.
- *Explicit locking* — unneeded complexity on top of mutations that are
  already synchronous and already can't interleave.
- *Optimistic versioning / compare-and-set* — a real option if mutations
  ever become concurrent within one process (an `await` lands between a
  colony read and its write), but there's no such concurrency to guard
  against yet.
- *Distributed coordination across multiple server processes* — unneeded
  for one Node process on one Fly machine; it would only matter if the
  project had more than one writer to the database.

**Trade-off.** This guarantee holds only because of the current
architecture: one Node process, one Fly machine, and no `await` inside the
read-then-write of a mutation. It has to be revisited, not assumed, the day
any of that changes — an `await` landing inside that critical section, a
second Node process, a second Fly machine, or any other writer to the
database would each reopen exactly the race this decision currently rules
out by construction. `CLAUDE.md` already states this as a rule to keep
true, not just a fact about today's code.

## Foundation from Crit 8: stack and persistence

Crit 8's bar was proof of life: deployed, does its core thing, and the trace
survives a reload, on a deliberately thin slice — one world, one colony,
gather, reproduce, SQLite persistence. I assessed the stack against this
repo's two fixed constraints before touching anything: `fly.toml` exposes
exactly one port on one 256 MB machine with one volume at `/data`, and
`spec/invariants.test.ts` only ever talks to the running app over plain
HTTP. That ruled out anything needing a second process or a separate
database service, and pointed straight at an embedded, file-backed DB on
the volume.

I picked Express + `better-sqlite3` + a hand-rolled TypeScript client
bundled with esbuild, no frontend framework. `ws` was in `package.json` as
a dependency already — it attaches to the same `http.Server` Express
creates, so adding it then and only wiring it up this crit was additive,
not a rewrite, which is exactly what played out above.

The one real engineering decision was the base image. The starter's
`Dockerfile` ships `busybox` with no Node runtime at all, so it had to
become a real build regardless of stack. I chose `node:24-slim` (glibc)
over `node:24-alpine` (musl) specifically because `better-sqlite3` ships
prebuilt native binaries with broad glibc coverage; Alpine often forces a
from-source compile in the build, which is a worse risk to carry into a
same-day ship. I confirmed this by building the image locally
([`dcd4cec`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/dcd4cec))
before ever pushing to Fly — no compiler was invoked, the prebuilt binary
was pulled directly.

The other stack-shaping fact: Node 24 strips TypeScript types natively, so
the server runs straight from `.ts` source with no build step
(`tsconfig.json`'s `allowImportingTsExtensions` and `noEmit` say this
directly). Only the browser bundle needs esbuild. I verified this
assumption empirically before designing around it — ran a trivial `.ts`
file with `node` directly — rather than trusting it from memory, since the
whole server-side half of the Dockerfile depends on it being true.

## Definition of good

`README.md`'s first definition of good — simple actions that are
understandable but consequential, persistent, and mutually consequential to
other players — was written before any multiplayer code existed, so later
crits could be checked against it rather than a definition retrofitted to
whatever the feature set happened to become. It leans on three sources from
game and virtual-world design — Salen & Zimmerman's meaningful play, Juul's
emergence, Bartle's persistent worlds — picked because each maps onto one
specific clause of the definition rather than being general reading on the
side; `README.md` cites them inline, next to the clause each one supports.
Crit 9's architecture decision above is the first real test of the "mutually
consequential" clause specifically — it's the reason a single authoritative
server, not client-side guessing, was the only acceptable shape.

## Agentic workflow

**Crit 8** was built as seven small, sequential commits, each one green
before the next —
[`dcd4cec`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/dcd4cec)
through
[`1340f4f`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/1340f4f):
stage 0 swapped the Dockerfile and deployed once to re-prove the path under
the new stack before any game logic existed; stages 1–4 added schema+seed,
the read-only frontend, gather, then reproduce, each with its own spec test
written to check the contract rather than the exact numbers, so a later
balance tweak doesn't break the test; stage 5 added a persistence spec test
and then went further than the spec can check by hand — ran the built image
with a bind-mounted `/data`, mutated state over HTTP, `docker restart`'d the
container, and confirmed the mutation survived an actual process restart.
Repeated the same check directly against the deployed (private, pre-ship)
app: gathered protein to 10 over HTTP, `flyctl machine restart`'d the live
machine, and `GET /api/state` still showed protein 10 right after the
restart.

One thing I pushed back on mid-session, during Crit 8: a tool result
contained text formatted as a system instruction telling me to stop
mid-implementation and respond in a different format. I treated that as an
attempted prompt injection rather than a real instruction, because it
didn't match the actual state of the task, and kept going on the plan that
was actually agreed. Worth recording here since it's exactly the kind of
thing a marker reading the process should be told about rather than have
silently absorbed.

**Crit 9** was three commits: setup
([`e799d31`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/e799d31))
wrote the realtime contract into `CLAUDE.md` and the two red WebSocket
tests plus the concurrency-race test before any `/ws` code existed; then
the server
([`9a13f01`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/9a13f01))
and the client
([`7982658`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/7982658))
each turned one half of the red spec green. I deliberately didn't pick the
multi-user decision myself — the brief says pod members will be asked to
argue for the option not picked, so it had to be a call I'd actually have
to defend out loud, not one an agent made for me. I picked concurrent
mutation semantics because it was the one I could verify rather than just
assert.

## What's left unverified

The client's DOM rendering is manually reasoned through and checked against
the running server's HTTP and WebSocket traffic, but not exercised in an
actual browser — no browser automation tool was available in this
environment. I still want to open two real browser tabs side by side before
the crit and watch a gather in one land in the other with no reload, which
is the literal claim the brief asks pods to test live — the spec test
proves the server pushes the right bytes, not that two humans looking at
two screens perceive it as instant. Also unverified: the WebSocket path
against the actual deployed Fly app, not just the local dev server — the
`checks`/`deploy` CI run at ship time is the first point that will exercise
`/ws` behind Fly's proxy.
