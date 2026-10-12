# Colony

A persistent multiplayer ant colony. Visit the app and your browser session
is given its own queen and workers, placed in a large shared 3000x3000 world
alongside every other colony already growing there. Send workers out to
gather sugar, biomass, and protein, hunt the wandering aphid population for
more protein, and spend protein to hatch new workers — all in real time,
all visible to anyone else looking at the same world. Nothing resets on a
refresh or a redeploy; the whole world lives in SQLite on the app's one
persistent volume. Click "How to play" in the running app for the full
control scheme and a numbered quick start — this file is the project
account, not the player manual.

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

This was written down before the multiplayer half of the project existed,
specifically so it could be checked against rather than retrofitted later.
Multiplayer is now real (Crit 10): colonies share one world, one resource
population, and one set of aphids, and every colony is visible to every
other — the test of "shared means more than co-presence" is now something
you can actually go try with a second browser, not just a design intention.
It's built on three ideas from game
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

## What's here

- **A shared, continuous 3000x3000 world**, populated with dozens of sugar,
  biomass, and protein deposits and dozens of wandering aphids, spread
  across natural, deterministically-seeded clusters rather than a grid —
  with room for many colonies to each spawn somewhere with their own nearby
  resources.
- **Real multiplayer, server-enforced.** An anonymous session cookie resolves
  to one colony; every other colony's queen is visible in the shared world,
  but you can only ever select and command your own workers, and your
  resources are private to you. There are no accounts or passwords — the
  colony itself is the identity.
- **RTS-style control**: drag-select workers, then click to move, gather, or
  attack. Gathering is real travel — a worker walks to a node, claims some of
  it, carries it home, and deposits it, not an instant credit. Sugar and
  biomass regenerate over time; protein is finite.
- **Hunting and carcasses.** Selected workers can attack a wandering aphid;
  it dies after enough hits and leaves behind a carcass worth protein, which
  must then be explicitly gathered like any other node.
- **Reproduction**: spend 50 protein to hatch a new worker at your queen.
- **Predators and worker survival.** Spiders roam the world as a hostile
  species, distinct from the neutral aphids: they detect a nearby worker on
  their own, chase it down, and attack. Workers have real, permanent health
  — injury and death are visible and final, with no revive — but can fight
  back (select and click a spider, same as hunting an aphid) or be moved to
  safety. A killed spider leaves a protein carcass just like an aphid. Your
  queen is never at risk, and there's still no player-vs-player combat.
- **Realtime and durable.** Every mutation is computed server-side and
  pushed to every open tab over WebSocket within about a second; everything
  that matters after a restart — colonies, workers, resources, creatures,
  sessions — lives in SQLite, not server memory.
- An in-game **"How to play" overlay**, opened from a button next to the
  title, documents the controls and a quick-start for a first-time visitor
  with no outside explanation needed.

## What's deliberately not here yet

No queen damage or death, no PvP, no worker corpses (a dead worker is simply
removed), no multiple predator species, no aphid respawning, no evolution, no
buildings or territory, no automated colony defenses, no formal biomes or
runtime procedural spawning (the world's content is seeded once,
deterministically, not generated live). No art pass beyond simple
shape/colour readability. Each of these is a layer to add on top of what's
here, not a rewrite of it.

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
