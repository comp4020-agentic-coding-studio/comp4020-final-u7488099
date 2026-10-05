# Crit 8

**What was the breakthrough that moved the work forward?**

Realising the Dockerfile's base image choice wasn't a detail to fix later —
it was load-bearing for whether `better-sqlite3` would even build on Fly's
remote builder. The starter's `busybox` placeholder has no Node runtime at
all, so the Dockerfile had to become a real multi-stage build regardless of
stack. Once I knew the persistence layer would be a native SQLite binding, I
checked prebuilt-binary coverage before writing a line of game logic:
`node:24-slim` (glibc) over `node:24-alpine` (musl), confirmed by actually
building the image locally before the first deploy rather than trusting the
reasoning. That one decision, made early and verified rather than assumed,
is why the stage 0 deploy — and every one after it — just worked instead of
failing on Fly's builder two hours before the cutoff.

The second breakthrough was smaller but changed how I staged the whole
build: discovering Node 24 strips TypeScript types natively meant the server
never needs a build step at all, only the browser bundle does. That
collapsed what I'd planned as a two-stage compile (tsc for the server,
esbuild for the client) into one, and meant `CMD` could just run
`src/server/index.ts` directly. I verified it with a two-line throwaway file
before designing the Dockerfile around it, rather than finding out the hard
way inside a failed container build.

**What did this work change about who I want to be as a software developer?**

I noticed myself wanting to add `ws` wiring in stage 0 "since the dependency
was already there anyway" — and stopping, because the actual scope was
gather-and-reproduce, not realtime. Writing that boundary into `CLAUDE.md`
before any code existed, rather than after catching myself mid-feature,
felt like the right instinct to keep. The habit I want to keep is deciding
scope on purpose and writing it down where future-me (or an agent) will
read it, instead of discovering the boundary by drifting past it.
