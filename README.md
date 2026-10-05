# Colony

A tiny persistent ant colony. One world, one queen, three workers to start.
Gather food to grow a protein stockpile, then spend it to hatch new workers.
Nothing resets on a refresh or a redeploy — the whole colony lives in SQLite
on the app's one persistent volume.

## What "good" means here (a first version)

A good version of this game makes a small number of simple actions feel
understandable but consequential. A stranger should see the core loop —
gather, earn protein, spend it to grow the colony — within a minute of
clicking, and every action's effect should be immediate and visible rather
than hidden behind a stat. The world should remember what they did: come
back tomorrow and the colony they grew is still there, not reset to a demo
state. As the project grows into the multiplayer ecosystem the brief
describes, those same individual actions are meant to become part of a
shared world other players encounter and respond to — multiple people using
it at once should change the experience itself, not just put two cursors in
the same room.

This is deliberately a first, rough definition, written down before the
multiplayer half of the project exists, so it can be checked against and
revised rather than retrofitted later. It's built on three ideas from game
design and virtual-worlds writing: Salen and Zimmerman's *meaningful play* —
an action's consequence has to be both legible and woven into the system,
not just a number ticking up, which is the direct source for "understandable
but consequential"; Juul's account of *emergence* — simple, open rules
producing play nobody explicitly scripted, rather than a fixed path, which is
the case for staying small (a handful of actions, not a feature list); and
Bartle's writing on persistent virtual worlds, where a world's state
accumulates from what players have actually done in it and is encountered by
whoever arrives next — the source for why "shared" has to mean more than
co-presence.

## What's here (Crit 8)

- One global colony: a queen, a handful of workers, five food nodes on a
  10x10 grid.
- Click a worker, then a food node, to gather. Protein goes up, immediately.
- Spend 50 protein to hatch a new worker at the queen's position.
- All of it lives on the server; the browser only ever renders what
  `GET /api/state` returns, never computes an outcome itself. Reload, or
  come back tomorrow, and it's still there.

## What's deliberately not here yet

No realtime — multiple tabs open right now don't see each other's moves;
that's Crit 9's job, and the direction this definition is pointing at. No
multiplayer or accounts yet — one colony, visible to everyone, no login. No
combat, predators or resource depletion — food nodes are an infinite supply
for now, not an economy. No graphics beyond plain positioned circles. Each of
these is a layer to add on top of what's here, not a rewrite of it.

## Stack

Express + `better-sqlite3`, with a small hand-written TypeScript client
bundled by esbuild — no frontend framework. `PROCESS.md` has the full
rationale.

## Sources

- Katie Salen & Eric Zimmerman,
  [*Rules of Play: Game Design Fundamentals*](https://mitpress.mit.edu/9780262240451/rules-of-play/)
  (MIT Press, 2003) — meaningful play: an action's outcome must be both
  discernible and integrated into the system.
- Jesper Juul, [*Half-Real*](https://half-real.net) (MIT Press, 2005) —
  emergence from simple, open rules, as distinct from fixed progression.
- Richard Bartle,
  [*Designing Virtual Worlds*](https://mud.co.uk/dvw/) (New Riders, 2003) —
  persistent worlds whose state accumulates from what players actually do in
  them.
