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
- **Real multiplayer, server-enforced.** A session cookie resolves to one
  colony; every other colony's queen is visible in the shared world, but you
  can only ever select and command your own workers, and your resources are
  private to you.
- **Guest play by default, with an optional account.** Jump straight in as a
  guest with no signup, or register/log in to make your colony durable
  across browsers and devices. Converting a guest to an account keeps the
  exact colony you already have; logging into an existing account never
  silently merges in unrelated guest progress. A typed-confirmation Reset
  Progress lets you deliberately start over without losing your account.
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
  safety. A killed spider leaves a protein carcass just like an aphid. There
  is still no player-vs-player combat — you can never attack another
  colony's workers or queen.
- **Queen health, colony defeat, and restarting.** Your queen has her own
  health bar and will slowly regenerate if left undamaged for a while, but a
  spider that wanders or chases its way close enough can attack her directly
  — if her health runs out, the colony is defeated: the queen becomes a
  non-interactive ruin, every remaining worker is lost, and stored resources
  are gone. You can also choose to abandon a struggling colony yourself at
  any time, with an explicit confirmation, which uses the exact same
  pipeline as a natural defeat. Either way, a defeated colony's ruin stays
  visible in the shared world, and you can start a fresh, full-health colony
  elsewhere in that same world whenever you're ready — the shared world
  itself never resets, no matter how many colonies rise and fall in it.
- **A small world event feed** surfaces a handful of recent, significant
  events — a worker lost to a spider, a colony falling or being abandoned, a
  new colony emerging — to everyone in the shared world, without exposing
  any session, cookie, or per-player identity.
- **Realtime and durable.** Every mutation is computed server-side and
  pushed to every open tab over WebSocket within about a second; everything
  that matters after a restart — colonies, workers, resources, creatures,
  sessions, and colony lifecycle state — lives in SQLite, not server memory.
- An in-game **"How to play" overlay**, opened from a button next to the
  title, documents the controls and a quick-start for a first-time visitor
  with no outside explanation needed.
- **Evolution and colony specialisation.** At three peak-population
  milestones a colony reaches by growing (5, 10, and 20 workers, ever, even
  if some are later lost), the player picks one permanent trait per
  milestone from three branches — Foraging, Survival, Brood — mixable
  freely with no prerequisites and no way to unpick a choice later. Traits
  durably change how that colony's workers gather, move, fight, and
  reproduce; choosing one takes effect immediately for every worker the
  colony already has, not just future ones. Previously every colony that
  grew to the same size played identically; now two colonies that grew the
  same way can end up meaningfully different, by player choice, and that
  difference persists for as long as the colony does. A colony's evolution
  is part of its permanent history: if it's defeated, its ruin remembers
  everything it ever chose and the peak size it reached, visible to everyone
  in the shared world, while a fresh colony started afterward begins with a
  genuinely blank slate. This is Juul's *emergence* made concrete — the same
  small, fixed set of rules producing colonies that diverge from each other
  in ways nobody scripted, purely from the choices players make as they
  grow.
- **Worker castes.** Choose worker, soldier, or scout when a new worker
  hatches — each with its own base health, speed, attack, carry capacity,
  and vision, permanent for that worker's lifetime. A soldier is tougher and
  hits harder but can't gather; a scout is fragile but sees much further
  than it can fight.
- **Fog of war.** Each colony only sees what its own queen and living
  workers can currently see; everything else — other colonies' units,
  unclaimed resources, wandering creatures — is dark until a unit of yours
  gets close enough to reveal it.

## What's deliberately not here yet

No PvP (still no way to attack another player's workers or queen, ever), no
worker corpses (a dead worker is simply removed), no ruin looting or decay,
no multiple predator species, no aphid respawning, no respec or un-evolving,
no genetics/breeding, no buildings or territory, no automated colony
defenses, no queen movement, no eggs/larvae, no formal biomes or runtime
procedural spawning (the world's content is seeded once, deterministically,
not generated live). No email, password reset, OAuth, or account deletion;
a single `admin` role, no finer-grained permissions. No art pass beyond
simple shape/colour readability, and no balancing pass on evolution's
percentages or caste stats. Each of these is a layer to add on top of what's
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
