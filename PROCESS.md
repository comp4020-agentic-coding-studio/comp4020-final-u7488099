# Process

## From the brief to the game

I built Colony because I wanted simple actions to create interesting situations without a scripted story. The early idea was closer to Agar.io, but instead of one growing character, the player manages a colony of ants in a world shared with everyone else.

My definition of good was that actions should be understandable but consequential: gathering should enable growth, growth should open new possibilities, and other players should affect what happens to you. Salen and Zimmerman's meaningful play, Juul's emergence, and Bartle's persistent worlds shaped that definition before any multiplayer code existed, so later stages could be checked against it.

I deliberately prioritised mechanics over artwork — circles and flat colours throughout — because I wanted to know whether the systems worked before making them look good.

## Technology and architecture

I chose TypeScript, Express, SQLite (via `better-sqlite3`) and a hand-written Canvas client, no frontend framework, which would have added a layer without solving a problem I had. SQLite was practical since the app runs on one Fly.io machine with one persistent volume; a separate database service would have added complexity the assignment didn't need. The trade-off is that nothing here scales across multiple servers — `PROCESS.md`'s own architecture-decision section says so explicitly, since concurrency correctness depends on there being exactly one Node process.

The server is the sole authority: the browser sends commands, the server decides whether they're valid and computes the result. Movement and combat run against in-memory state for speed and are checkpointed to SQLite periodically, so the game stays responsive without losing progress across a restart — a split decided in the early commits (`dcd4cec`, `c5a3b60`) and unchanged since.

## Crit 8: a small, persistent loop

For the first crit I focused on one playable loop: a single colony, a queen, workers, gather protein, spend it to reproduce. I deployed to Fly.io and restarted the live machine to confirm progress survived it, not just a local test (`1340f4f`, `1d09c13`). Persistence mattered because if the world forgot everything on refresh, growing a colony would feel pointless.

The prototype was limited — gathering was closer to an instant credit than real travel, and players couldn't interact — but it gave me something to test against my own definition of good (`reflections/crit-8.md`).

## Crit 9: realtime and concurrency

Next I made the world feel alive: a continuously running simulation and WebSocket pushes so players see changes without refreshing (`e799d31`, `9a13f01`, `7982658`), choosing WebSockets over polling since the server needed to push frequent updates.

Concurrency became a real problem here: two simultaneous reproduce requests could both see enough protein for one reproduction and both succeed, creating resources from nothing. I made mutations run synchronously with no `await` between reading and writing, then wrote a test firing two competing requests and asserting exactly one succeeds — the decision came out of that test passing, not the other way around (`PROCESS.md`'s concurrent-mutations decision, `reflections/crit-9.md`).

## Crit 10: making it actually shared

For the third crit I gave separate browser sessions their own persistent colony in one shared world, using a session cookie the server resolves itself — never anything the client asserts — plus ownership checks on every command and a durable action log (`e8fb85a`, `7c00c6e`, `2b88996`). Accounts and guest-to-account conversion came later, in Stage 11; Crit 10's job was a durable session and one colony's commands staying invisible to another.

A spec test I wasn't allowed to weaken caught a real gap: a session's own first response had to already list the next session's colony, which meant keeping one spare colony pre-minted rather than creating colonies lazily (`reflections/crit-10.md`). The test taught me the design, rather than me arguing it was wrong.

Afterward, Stage 6b through Stage 9 built the world out further: a deterministic resource layout, hunting and worker death, queen defeat and restarting, and colony evolution.

## Working with Claude Code

I used Claude Code as the implementation agent and treated my own role as closer to product owner: I decided mechanics, priorities and trade-offs, while Claude implemented, wrote tests, and investigated failures. Large, vague requests produced too many changes at once; small, sequential commits per stage worked better, since I could review gameplay and test output between each one.

`README.md` stated the intended experience, `CLAUDE.md` recorded development rules stage by stage, and `spec/` held the testable requirements — ownership, resource accounting, combat, persistence and realtime updates each have dedicated spec files. A change that broke an existing test had to be justified, not patched around.

During Stage 12, the agent misreported a spider-population recovery as organic ecology behaviour before I had it re-check the evidence and find the real cause — a stale process re-seeding on restart. After that I got more specific about scope: no resetting the real database to chase a failure, no touching unrelated systems, nothing deployed before the full suite was green.

## Corrections and trade-offs

Passing tests didn't always mean the gameplay made sense. Late in the project I added queen movement, an autonomous Guard, and PvP combat, and the PvP work needed two corrections. One was the test itself: the original worker-PvP test used more attacking workers than the mechanic needed, so I reduced the count once fewer attackers still reliably won. The other was a real balance gap: Guards were excluded from PvP in Stage 14A as a staged rollout, and once Stage 14B made them attackable, a Guard could kill a lone attacker before it could fight back at all, making a guarded colony unbeatable by one player regardless of skill. I fixed that with a short reaction delay before a Guard engages a new threat (`GUARD_PLAYER_UNIT_REACTION_DELAY`), rather than lowering its health, since the goal was a winnable fight, not a weaker Guard.

Both needed a human call about what "fair" meant — Claude could implement a rule precisely, but not decide whether the result was good to play.

## What I learned

I left out nests, eggs, buildings, breeding and finished artwork on purpose — the project already had enough interacting systems that reliability mattered more than new ones. If I kept going, I'd want isolated test environments earlier than Stage 11, and more unscripted playtesting with people who hadn't built the game.

The main lesson was that agentic coding made implementation faster, but not the decisions underneath it. The hard part stayed deciding what "good" meant for this game, noticing when the implementation didn't match that, and finding real evidence — a measurement, a restart, a second browser tab — that something was genuinely fixed rather than assumed to be.
