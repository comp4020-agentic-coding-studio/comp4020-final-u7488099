# Colony

A tiny persistent ant colony. One world, one queen, three workers to start.
Gather food to grow a protein stockpile, then spend it to hatch new workers.
Nothing resets on a refresh or a redeploy — the whole colony lives in SQLite
on the app's one persistent volume.

## What's here (Crit 8)

- One global colony: a queen, a handful of workers, five food nodes on a
  10x10 grid.
- Click a worker, then a food node, to gather. Protein goes up.
- Spend 50 protein to hatch a new worker at the queen's position.
- All of it lives on the server; the browser only ever renders what
  `GET /api/state` returns, never computes an outcome itself. Reload, or
  come back tomorrow, and it's still there.

## What's deliberately not here yet

No realtime — multiple tabs open right now don't see each other's moves;
that's Crit 9's job. No multiplayer or accounts — one colony, visible to
everyone, no login. No combat, no predators, no resource depletion — food
nodes are an infinite supply for now, not an economy. No graphics beyond
plain positioned circles. Each of these is a layer to add on top of what's
here, not a rewrite of it.

## Stack

Express + `better-sqlite3`, with a small hand-written TypeScript client
bundled by esbuild — no frontend framework. The server runs straight from
its TypeScript source: Node 24 strips types natively, so there's no server
build step, only the client bundle. `PROCESS.md` has the full rationale for
why this stack over the obvious alternatives.

## Sources

- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — the
  synchronous API and `db.transaction` used for the reproduce mutation.
- [Node.js type stripping](https://nodejs.org/api/typescript.html) — running
  `.ts` server files directly, which shapes `tsconfig.json` and the
  Dockerfile.
- [esbuild](https://esbuild.github.io/) — the client bundle.
