# Process overview

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
