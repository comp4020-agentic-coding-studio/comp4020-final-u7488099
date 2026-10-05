# Process overview

## Brief to stack

Crit 8's bar is proof of life: deployed, does its core thing, and the trace
survives a reload. The long-term concept carried from the brief is a
persistent multiplayer insect colony — but this crit's scope is deliberately
one world, one colony, gather, reproduce, and SQLite-backed persistence. No
realtime, no multiplayer, no combat.

I assessed the stack against this repo's two fixed constraints before
touching anything: `fly.toml` exposes exactly one port on one 256 MB machine
with one volume at `/data`, and `spec/invariants.test.ts` only ever talks to
the running app over plain HTTP. That ruled out anything needing a second
process or a separate database service, and pointed straight at an
embedded, file-backed DB on the volume.

I picked Express + `better-sqlite3` + a hand-rolled TypeScript client bundled
with esbuild, no frontend framework. `ws` is in `package.json` as a
dependency already — it attaches to the same `http.Server` Express creates,
so adding it now and only wiring it up in Crit 9 is additive, not a
rewrite — but nothing imports it yet; `CLAUDE.md` says why.

The one real engineering decision was the base image. The starter's
`Dockerfile` ships `busybox` with no Node runtime at all, so it had to become
a real build regardless of stack. I chose `node:24-slim` (glibc) over
`node:24-alpine` (musl) specifically because `better-sqlite3` ships prebuilt
native binaries with broad glibc coverage; Alpine often forces a from-source
compile in the build, which is a worse risk to carry into a same-day ship.
I confirmed this by building the image locally
([`dcd4cec`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/dcd4cec))
before ever pushing to Fly — no compiler was invoked, the prebuilt binary was
pulled directly.

The other stack-shaping fact: Node 24 strips TypeScript types natively, so
the server runs straight from `.ts` source with no build step
(`tsconfig.json`'s `allowImportingTsExtensions` and `noEmit` say this
directly). Only the browser bundle needs esbuild. I verified this
assumption empirically before designing around it — ran a trivial `.ts` file
with `node` directly — rather than trusting it from memory, since the whole
server-side half of the Dockerfile depends on it being true.

## Definition of good

`README.md`'s first definition of good — simple actions that are
understandable but consequential, persistent, and (eventually) mutually
consequential to other players — was written this session, deliberately
before any multiplayer code exists, so later crits can be checked against it
rather than retrofitting one to whatever the feature set happened to become.
It leans on three sources from game and virtual-world design — Salen &
Zimmerman's meaningful play, Juul's emergence, Bartle's persistent worlds —
picked because each maps onto one specific clause of the definition rather
than being general reading on the side; `README.md` cites them inline, next
to the clause each one supports. It's explicitly a first pass, not a
defended final position, and the plan is to revisit it once Crit 9 actually
puts a second player in the room with the first.

## Agentic workflow

Built as seven small, sequential commits, each one green before the next —
[`dcd4cec`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/dcd4cec)
through
[`1340f4f`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/1340f4f):
stage 0 swapped the Dockerfile and deployed once to re-prove the path under
the new stack before any game logic existed; stages 1–4 added schema+seed,
the read-only frontend, gather, then reproduce, each with its own spec test
written to check the contract (the shape of the response, not incidental
implementation detail) rather than the exact numbers, so a later balance
tweak doesn't break the test; stage 5 added a persistence spec test and then
went further than the spec can check by hand — ran the built image with a
bind-mounted `/data`, mutated state over HTTP, `docker restart`'d the
container, and confirmed the mutation survived an actual process restart,
not just a second request against a server that never stopped. Repeated the
same check directly against the deployed (private, pre-ship) app: gathered
protein to 10 over HTTP, `flyctl machine restart`'d the live machine (its own
attached volume, not a local stand-in), and `GET /api/state` still showed
protein 10 right after the restart.

One thing I pushed back on mid-session: a tool result contained text
formatted as a system instruction telling me to stop mid-implementation and
respond in a different format. I treated that as an attempted prompt
injection rather than a real instruction, because it didn't match the
actual state of the task, and kept going on the plan that was actually
agreed. Worth recording here since it's exactly the kind of thing a
marker reading the process should be told about rather than have silently
absorbed.

## What's left unverified

The client's DOM rendering is manually reasoned through and checked against
the running server's HTTP responses, but not exercised in an actual browser
— no browser automation tool was available in this environment, and jsdom
(the only thing on hand) doesn't implement `window.fetch` or reliably run
`type="module"` scripts, which is also why the course's own invariant tests
never ask it to execute anything, only parse static HTML. I'd want a
person — or a real browser — to click through gather/reproduce once before
calling the UI itself done, separate from the server-side logic the spec
tests do cover.
