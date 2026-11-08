# Colony

Colony is a persistent multiplayer ant-colony game for people who want to jump into a shared world, grow something, and see what happens when other players do the same. Each player controls a queen and units in a world that continues without them. It is closer to a survival timekiller than a permanent base-building game: colonies can grow, fight, die, and start again.

## What "good" means

A good version of Colony makes simple actions understandable but consequential. Gathering food should visibly enable reproduction; reproducing should create more possibilities for exploration and survival. Players should understand this loop quickly, without needing a long tutorial. But the consequences should also extend beyond one session: resources disappear, creatures move, colonies fall, and other players encounter the results.

Salen and Zimmerman's [*Rules of Play*](https://mitpress.mit.edu/9780262240451/rules-of-play/) (2003) describes meaningful play through discernible outcomes integrated into a larger system. This shaped the gather-carry-deposit loop: resources do not simply appear in a counter when clicked. Juul's [*Half-Real*](https://half-real.net) (2005) argues for emergence from relatively simple rules rather than entirely scripted progression. That influenced the combination of workers, predators, ecology, evolution and combat. Bartle's [*Designing Virtual Worlds*](https://mud.co.uk/dvw/) (2003) helped frame persistence as a shared history, not merely saving an individual player's progress.

## What players can do

Players enter as guests or create accounts. Each controls their own colony while sharing a 3000x3000 world with others. Workers gather finite sugar, biomass and protein; ecology introduces new resources and creatures over time. Aphids can be hunted, spiders threaten units, and collected protein supports reproduction. Players choose Workers, Scouts or Soldiers and unlock permanent evolution traits as their colony grows.

Queens can move slowly and hold a limited amount of resources. An autonomous Guard protects each queen but can be killed. Players can attack enemy units and queens; a defeated colony leaves a ruin, and its player may begin again elsewhere. Fog of war makes exploration matter. A server-authoritative simulation, SQLite persistence and WebSocket updates keep the world shared and responsive.

## What is enforced, and what needs judgement

The test suite checks ownership, resource accounting, competing commands, combat, persistence and realtime state updates. Server-side validation prevents a player from commanding another colony or creating resources by changing client requests. These are properties we can test.

Whether the game is interesting cannot be established by passing tests. I judge that through the clarity of the initial gather-and-grow loop, whether exploration creates decisions, and whether another player's actions produce situations that would not exist in a solo game. The crits and manual browser testing exposed problems automated checks missed, including Guard behaviour that made PvP unfair.

## What I chose not to build

I rejected permanent offline protection because I wanted a vulnerable, changing world rather than a base that waits safely for its owner. I also avoided nests, eggs, complex buildings and finished artwork. Those features might add depth, but they would not compensate for unreliable shared-state behaviour. Simple shapes kept attention on whether the underlying mechanics worked.

This is still a prototype, not a balanced commercial game. Its main achievement is connecting a small set of actions to consequences that other people can see and affect.
