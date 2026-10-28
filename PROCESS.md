# Process overview

## Stage 12: persistent world ecology, regeneration & finite resources

Every stage through 11 left the world's resources/creatures as a one-time
seed that only ever depleted — nothing ever replaced a gathered-out node or
a hunted-out aphid/spider population, and a defeated colony's ruin blocked
its ground forever. The brief asked for a lightweight ecology layer that
keeps a long-lived shared world alive without turning into a new gameplay
system. A plan was written and locked in before any code — zone shape,
density targets, regen gating, scarcity weighting, the global entity cap,
queen/ruin exclusion, and the admin visibility endpoint were all decided up
front, then implemented against that plan rather than discovered along the
way.

**Deciding the zone shape was the first real design question, and the
answer came from refusing to invent a second layout for the same world.**
A uniform grid was the obvious starting point, but Stage 6b's anchor
clusters don't align to any grid — a 300-unit cell can split one anchor's
cluster across a boundary, breaking the "one cell ≈ one anchor" assumption
a uniform grid needs. The fix was to stop treating zones as a new concept
and instead reuse Stage 6b's own shape directly: 10 anchor-centered circles
at the exact same `colonySpiralPosition(i)` coordinates `createColony()`
and world generation already use, plus a background grid for everywhere
else. This meant zero new coordinates to invent or store — calling the same
pure function from any process at any time reproduces the same 10 centers
forever.

**Two revisions were made mid-design, both from the same instinct: don't
let an ecology-scoped fix leave a contradiction sitting next to it.** The
first draft scoped "finite resources" to only ecology-spawned entities,
leaving the pre-existing `amount: null` infinite-resource path untouched
everywhere else in the game. Investigation found that path was already
almost entirely vestigial in production — every seeded constant was already
finite, and the only code that could ever create a null-amount node was two
test fixtures that didn't even assert infinite-ness. That made the
reversal cheap: the plan was rewritten to make "no gatherable resource may
be infinitely gatherable" a global invariant, not an ecology-scoped one,
and the one line that actually implemented infinite gathering at runtime
was deleted outright. The second revision reversed the first draft's
"ruins get no ecological protection" position — a visible ruin is still
occupying its ground for exactly as long as it's drawn on screen, so a
resource node spawning directly on top of a still-visible ruin would read
as broken, not as a feature. Both revisions were made by re-deriving the
actual requirement rather than patching around the first draft's gap.

**`MAX_ECOLOGY_ENTITIES` needed its own unit conversion before it meant
anything.** The density-target math throughout the plan is a *weighted*
sum (sugar×1, biomass×1.5, protein×2, aphid×2, spider×5) — useful for
deciding what each zone should regenerate toward, but the wrong unit for a
population safety cap, which has to count raw rows regardless of type.
Converting the same per-tier mix back to raw counts gave a 160-195 raw
entity "normal" range, and `300` was chosen as roughly 1.5-1.9x that range
— comfortably above ordinary variance (several zones catching up at once
after a busy session) without being so high it stops meaning anything as a
backstop.

**Performance was measured against both a normal and a stress population,
not assumed safe by extension from Stage 7/9's precedent.** A throwaway
script (not committed, following the exact pattern of Stage 9's own
throwaway benchmark) used `spec/ecology.test.ts`'s direct-import,
isolated-`DB_PATH` harness to seed ~180 raw entities (the plan's normal
steady-state range) and separately 300 (the hard cap), forced every zone
past its regen deadline every tick so the measurement exercises real
scarcity-weighted selection and placement-retry work rather than a cheap
"still waiting" early-out, and timed `advanceEcology()` over 500 ticks in
each scenario: **~0.153ms/tick average at the normal population (~32,765x
headroom) and ~0.178ms/tick average at the stress population (~28,070x
headroom)** under the 5-second evaluation interval. Both numbers land in
the same trivial-at-this-scale territory Stage 7/9 already established for
`advanceSimulation()`, confirming the single-global-pass design (explicitly
modeled on Stage 10's postmortem of the *reverted* server-side fog system,
which had no spatial index and no measured budget) stayed cheap in
practice, not just in theory.

**The admin ecology endpoint followed the existing admin-page pattern
exactly, with no new idiom introduced.** `GET /api/admin/ecology` behind
the same `requireAdmin` middleware every other admin route already uses;
`public/admin.html`/`src/client/admin.ts` gained one more plain `<table>`
section following Stage 11's established per-section shape (typed
interface matching the server JSON, `escapeHtml()`, fetched in the same
`Promise.all` as every other section) — deliberately no charts or new
visual language for a page that's otherwise entirely tables.

**Verification ran targeted tests before the full suite, matching the
plan's own order.** `spec/ecology.test.ts` (new, originally 17 tests
covering zone membership, density measurement, regen gating, scarcity
weighting, the global cap, queen/ruin exclusion and its proportional
target reduction, ruin-lifetime filtering, restart safety, and the
finite-resource invariant) was run in isolation first, then the full
`pnpm check` suite. Full-suite runs surfaced failures in three black-box
spec files — `spec/colony.test.ts`, `spec/multiplayer.test.ts`, and
`spec/realtime.test.ts` — and an earlier report of this stage's results
undercounted and mis-categorized them ("4 spider-related + 2
movement-related"). Re-checked carefully: the correct breakdown across two
consecutive full-suite runs was **3 spider-related + 2 movement-related**
on the first run, and 3 spider-related + 3 movement-related on an
immediately following second run with no code changes in between — the
movement-related count itself varies run to run, consistent with the
wall-clock distance-tolerance flakiness `vitest.config.ts`'s own header
comment already documents. The spider-related failures, by contrast, were
identical across both runs and traced to a real cause, not flakiness:
these three spec files have no isolated `DB_PATH` override and instead run
as black-box HTTP tests against the live, shared dev database through a
running server — so an assertion like "seed should always include at
least one spider" fails whenever the live world's spider population has
actually hit zero. That is precisely the extinction problem the addendum
below fixes at the code level; the live dev server was not yet confirmed
to be running the fix at the time these failures were observed, so they
remain open until it's restarted and re-verified — see that section.
All of this was confirmed by reading the actual failing code
paths, not patched around — per the standing instruction for this stage,
the dev world was not reset to chase these failures down.

**A real extinction in the shared dev world exposed a gap the original
plan hadn't considered: WHEN to regenerate and WHAT to regenerate were
answering two different questions, and only one of them accounted for a
species going globally extinct.** The original scarcity weighting inside
`pickSpawnType` only ever compared a zone's current count of a type
against that zone's own local expectation — and spiders were never part
of any zone's local baseline to begin with (`ANCHOR_BASE_SHARE.spider` and
`BACKGROUND_BASE_SHARE.spider` are both 0, since spiders are seeded
scattered, never anchor-clustered). That meant `pickSpawnType` excluded
spiders from ecology-driven selection unconditionally — once the seeded
population was hunted to zero, nothing in the system could ever bring one
back, regardless of how depleted the species was globally. Local density
alone can't see a global extinction; it was never designed to.

The fix adds a second, independent multiplier to WHAT gets selected —
rarity x local scarcity x global scarcity — while leaving WHEN
regeneration happens (the continuous-depletion-deadline gate) completely
untouched, exactly as asked. Resolving that design meant deciding what a
type with no local baseline at all should do in the local-scarcity term:
excluding it (the old behavior) was the bug, and inventing an artificial
nonzero local baseline for spiders would have meant fabricating a cluster
affinity they were never designed to have. The chosen resolution was a
neutral local multiplier of 1 whenever a zone/tier has no local
expectation for a type — local scarcity still fully governs every type
that does have one, and the new global term is what now gives
zone-invisible species like spiders a path back from zero. Four explicit
rarity ranks (Common/Uncommon/Rare/Extremely Rare, with sugar/biomass+
aphid/protein/spider assigned in that order) and a bounded exponential
global-scarcity curve (`exp(K * deficiency^2)` capped at 50x, K=4) turn
"how far below its desired population is this species, globally" into a
weight — tuned so mild depletion barely moves the needle (~1.28x at 75% of
target) while a fully extinct species' weight can be large enough to
outweigh an abundant common type's, without ever hard-capping or deleting
an oversupplied type (the desired populations are ecological targets, not
caps — only `MAX_ECOLOGY_ENTITIES=300` remains a hard technical ceiling,
unchanged and untouched by this addendum). Desired populations scale with
world area rather than being hardcoded absolutes, reusing Stage 6b's own
original seeded totals as the reference values at today's 3000x3000
world — so the same formula keeps meaning the same thing if the world
ever grows. An apex-predator concept was discussed as a natural next step
once a species can go locally extinct and recover, but was deliberately
left as a documented future non-goal rather than implemented here, since
it's a different kind of system (trophic interaction, not population
scarcity) and out of scope for this addendum.

Twelve new deterministic tests were added to `spec/ecology.test.ts`
(29 total, up from 17 — all 17 original tests pass unchanged), covering
the multiplier at and above target, mild vs. severe depletion, the
extinction cap, world-size-proportional scaling, an extinct rare type
outweighing a healthy common one, a recovered type falling back to
neutral, local scarcity still biasing selection between equally-rare
types, the global entity cap still holding under maximal extinction
pressure, and deterministic RNG-driven selection. Rather than reset the
live dev world's genuine zero-spider state to make a test pass, the
instruction was the opposite: leave it alone and watch. A read-only
inspection of the shared dev database shortly afterward showed the spider
count at exactly 10 and was initially reported as organic ecology-driven
recovery — **that report was wrong, and was corrected before being handed
back.** Every one of the 10 rows shares one identical `created_at` and
matches `SPIDER_SEED_POSITIONS` position-for-position — the signature of
`db.ts`'s pre-existing, Stage-7-era `seedSpidersIfMissing()` boot
migration bulk-firing (triggered by a separate, stale `node --watch`
process restarting on the source edits and briefly re-importing `db.ts`
against the live DB), not of this addendum's scarcity-weighted spawning.
The dev server actually serving the shared world on port 8080 was started
hours before this addendum's code was written and was not running under
`--watch`, so it has almost certainly not even loaded the new global-
scarcity code yet. No genuine live-world observation of ecology-driven
spider recovery was made this round — unit tests are the only verification
this addendum currently has.

**Follow-up fix, same round:** the false-positive investigation above
pointed at a real bug in `seedSpidersIfMissing()` itself, not just an
accident of a stale `--watch` process. Its gate was a live species count
(`COUNT(*) FROM creatures WHERE species='spider' == 0`), which can't tell
"never had spiders" apart from "legitimately hunted to extinction" — so
*any* restart landing while a world's spider count was at zero, intended
or not, would have silently re-seeded it. This directly conflicts with
Stage 12's whole premise (ecology, not boot migration, owns population
recovery), so it was fixed before moving on: `worlds` gained a durable
`creatures_seeded` marker column, consumed exactly once by a merged
`seedCreaturesIfEmpty()` (which now folds in what `seedSpidersIfMissing()`
used to do) and never consulted again. `resetForTests()`/
`resetProductionWorld()` needed no change — a fresh world row always
starts unmarked. Three new regression tests (32 total) prove a world's
extinction — spider-only or total — survives any number of simulated
restarts, and that a genuinely new world is still seeded exactly once. See
`CLAUDE.md`'s "Stage 12 fix: the legacy spider seeder could undo a real
in-game extinction" section for the full design and the fix's limits.

## Stage 12.5A: removing the Stage 5 regeneration loop Stage 12 left running

**Stage 12 successfully made resource amounts finite at the schema/claim
level, but manual production-style playtesting exposed that the older
Stage 5 per-node regeneration loop was still active.** Stage 12's own
finite-resource work (above) closed the `amount: null` infinite-gather
path and made every newly-created node genuinely finite — that part was
correct and remains correct. What it did not touch, because it never
needed to create a node to prove its own invariant, was Stage 5's
separate, older machinery: `advanceResourceRegen()`'s standing 10Hz-tick
`UPDATE` and `attemptGatherClaim()`'s renewable-type no-delete-at-zero
branch, both still fully wired into the live simulation loop and both
still keyed off `RESOURCE_REGEN_RATES`. A sugar or biomass node could
still be gathered down to zero, sit there without being deleted, and then
climb back up on its own with nobody touching it — in-place refill, not
ecology-driven replacement. This was a real contradiction with the
project's own intended design (world-level renewal is supposed to come
exclusively from Stage 12's ecology spawning *new* rows, never from an old
row refilling itself), and it had been shipping, unnoticed, since Stage 5
— Stage 12's finite-resource investigation looked only at node *creation*
and missed that claims still had a second, older amount-recovery path
behind them.

**Why the existing automated test suite didn't catch this:** it wasn't a
coverage gap so much as an inverted assertion. The Stage 5-era test block
in `spec/simulation.test.ts` ("Stage 5: renewable resource regeneration")
existed specifically to assert the old, now-undesired behavior — that a
renewable node floors at 0 and survives, and that it regenerates over
simulated time. Those tests passed continuously through Stage 12 because
Stage 12 never removed the mechanism they were testing; they were
correctly testing code that had quietly become a bug. Nothing short of
actually playing the live game end-to-end (gather a node to zero, wait,
watch it come back) was going to surface this — which is exactly how it
was found.

**The fix removed refill-in-place entirely rather than patching around
it**, per the explicit corrected invariant: every individual natural
resource node (sugar, biomass, protein source nodes; aphid/spider
carcasses) is finite and never regenerates or refills in place, full
stop. In `simulation.ts`: `advanceResourceRegen()` and its 10Hz-loop call
site were deleted outright; `attemptGatherClaim()`'s renewable special
case was removed so every node type now follows the exact same
unconditional "claim capped at what's left, delete at `amount <= 0`" path
protein and carcasses already used. In `balance.ts`:
`RESOURCE_REGEN_RATES` and the Sugar/Biomass regeneration-rate constants
were removed, since nothing legitimate still referenced them. The old
Stage 5 test block was deleted rather than weakened, and replaced with
deterministic coverage of the corrected invariant: sugar/biomass amount
decreases on claim; each deletes its node at zero exactly like protein and
carcasses; a partially-depleted node does not recover amount merely
because simulation time advances with nothing gathering it; a depleted
node never reappears with the same id; amount can never go negative;
existing contested/final-claim concurrency guarantees are unchanged. A
companion assertion in `spec/ecology.test.ts` confirms the Stage 12 side
holds too: ecology can create a brand-new node in a depleted zone, but
that is always a distinct row, never the old node coming back.

**Verification deliberately went beyond the unit-test suite, matching how
the bug itself was found.** After `pnpm check` passed (targeted
simulation/ecology tests first, then the full suite, then typecheck), the
fix was verified against the real running local dev server — not an
isolated test DB — reproducing the exact gameplay path that surfaced the
bug in the first place. For both a sugar node and a biomass node: the
node's amount was observed decreasing across real gathers, left idle for
several seconds with zero recovery, driven down to exactly zero across
further gathers, and then confirmed deleted from three independent
sources — a direct read-only query against the live SQLite file, the
authoritative in-memory server state, and `/api/state`'s own client-facing
payload. No row manually edited to force any of this. Sugar depleted and
deleted cleanly on the first attempt; the first biomass attempt was
interrupted midway by a real, legitimate spider kill against the test
colony's workers (an actual live-world hazard, not a test artifact), which
was recovered from using the game's own sanctioned Abandon Colony → Start
New Colony flow (no admin tool, no direct DB write, no production system
touched) — the resulting new colony then completed a full, clean,
uninterrupted biomass depletion run with no further issues. As with every
other addendum to this stage, no production system was touched, no
deploy was made, and no world reset of any kind was performed to produce
or verify this fix — all verification ran against the local dev
environment only.

**A separate, pre-existing flaky test surfaced and was fixed during this
round's verification, unrelated to the regeneration-loop bug itself.**
Running `spec/ecology.test.ts` repeatedly (required to prove the fix
above was genuinely green, not a one-off pass) turned up an intermittent
failure in "depletion deadline + recovery > spawns exactly one entity
once the deadline elapses." Reverting to the pre-Stage-12.5A code and
re-running confirmed this had nothing to do with the regeneration-loop
removal — it reproduced identically on the original, unmodified code.
Root cause: every anchor zone's radius overlaps its nearest neighbors
(anchors sit closer together than `2 × ECOLOGY_ANCHOR_ZONE_RADIUS`), so a
test that empties the entire world leaves every anchor pending at the
same tick; a spawn placed in a neighboring anchor's zone can land inside
the overlap lens and get double-counted by the test's own
radius-scoped counter, an isolation bug in the test's setup rather than
in `advanceEcology`. Fixed by stocking every other anchor to its target
density before asserting on the one zone under test, so it is the only
zone ever pending — not by loosening the assertion. Confirmed with 20
consecutive full-suite runs, zero failures, after the fix (versus a
visible failure roughly 1 run in 10 before it, on both the old and new
code).

## Stage 11: accounts, entry flow, guest persistence, reset & admin

Every stage through Crit 10/Stage 10 had exactly one identity concept: a
`sid` cookie resolving straight to a colony, with no login, no durability
across devices, and no way for a player to deliberately wipe their own bad
run short of abandoning (Stage 8) and starting over under the same session.
This stage's brief asked for real accounts, a guest-preserving entry flow,
a player-triggered Reset Progress, and a minimal admin surface — all without
rewriting Crit 10's resolution chain or touching the live production volume
destructively. Two decisions were locked in before any code: admin accounts
are provisioned via boot-time env vars (idempotent create-or-promote, never
clobbering a changed password), and the admin interface is a separate
`/admin` page rather than a view folded into the game SPA, since it's a
surface only admins ever see and gains nothing from sharing a bundle with
the player client.

**Architecture: one more indirection, not a rewrite.** The existing
`sessions` table gained a single nullable `account_id` column — every
pre-Stage-11 row simply reads `NULL`, which is exactly the correct "this is
a guest" value, so every returning guest's colony keeps resolving identically
to before with zero special-cased "legacy session" branch anywhere. A new
`accounts` table (`username` unique case-insensitively, scrypt hash/salt/
params per row, `active_colony_id`, `role`) is the only genuinely new
concept; `getColonyForSession()` — the one function `broadcastState()` and
every request already funnel through — simply got one more branch: an
account session's authoritative colony is `accounts.active_colony_id`, read
fresh every time, never cached. This mattered specifically because of the
Stage 8 lesson recorded above: a WebSocket connection must never cache a
value that can be re-pointed mid-connection. Stage 8 taught that lesson for
colony restarts; Stage 11 is the first time a *different kind* of
re-pointing (an identity switch, not a colony defeat) exercises the exact
same hazard, and caching only `sessionId` on the connection — never
`colonyId`, never `accountId` — turned out to require no new code at all,
just confirming the existing discipline already covered the new case.

**Guest-preserving conversion fell out of "ownership was never on the colony
row" for free.** The spec asked for guest→account conversion to adopt the
guest's existing progress, not duplicate it. Because a colony's owner has
always been *whatever points at it* (a session row or, now, an account row)
rather than a field on the colony itself, `register()`'s conversion path is
a two-line reassignment — point the new account's `active_colony_id` at the
session's current colony, then point the session at the account — with no
copy, no merge, and no new schema. The harder design question was login with
an *existing* account on a browser that already has unrelated guest
progress: the spec was explicit that this must not auto-merge, so `login()`
simply never touches the guest colony at all. It becomes an orphaned ruin
from the session's perspective — structurally identical to a Stage 8
defeated colony sitting unreferenced in `colonies`, just reached by an
identity switch instead of a queen's death. No new "orphaned colony" concept
needed inventing; the shape already existed.

**Reset World's isolation discipline was treated as the load-bearing
requirement it is, not a nice-to-have.** The brief and the user's own
standing instruction were unambiguous: Reset World must never be exercised
against the real dev or production database during implementation, only
manually, later, by a human through the live admin UI. `spec/
admin-reset-world.test.ts` was written to make that true by construction
rather than by care: it spawns a genuinely separate child `node
src/server/index.ts` process, pointed at its own throwaway DB file
(`./.data/colony.admin-reset-world-test.db`) on its own port, with its own
admin credentials — sharing no process, no port, and no file with the dev
server or any other test. Every assertion inspects that isolated database
directly with a second, independent `better-sqlite3` handle (not just the
HTTP response), to actually prove the reset's SQL-level semantics: accounts
and `action_log` survive, colonies/workers/resources/sessions are wiped and
reseeded, the admin can still authenticate afterward, a stale pre-reset
cookie no longer resolves to anything, and a repeated reset is idempotent.
This test was run repeatedly during development; the real dev database was
never reset by it, and Reset World itself was never invoked against
anything but this one disposable file for the entire stage.

**An unrelated incident, encountered mid-stage and worth recording for the
same reason Crit 8's prompt-injection anecdote and Stage 10's fog-of-war
reversal are recorded here: a marker reading this file should be told about
it, not have it silently absorbed.** While re-verifying the suite late in
this stage, the real dev database files (`.data/colony.db` and its `-wal`/
`-shm` companions) were discovered to have been deleted from disk by a cause
that was never identified, despite a thorough check: no test file points at
that path, no reset mechanism had been invoked, and a search of shell
history and every deletion call site in the codebase (`rmSync`, `unlinkSync`,
`rm -rf`/`rm -f`) turned up nothing that could explain it. The data was not
actually lost at the moment of discovery — the still-running dev server
process held open file descriptors to the now-unlinked inodes, and under
SQLite's WAL journal mode a process with a file already open keeps reading
and writing that file's real content without error even after every
directory entry pointing at it is gone; a separate `sqlite3` CLI invocation
against the same path saw a completely different, auto-created, empty file
instead (confirmed via inode-number comparison, `lsof -p <pid>` against a
plain `ls -lai`). This meant the data was recoverable — `better-sqlite3`'s
`db.backup()` could still reach it from inside the live process — but only
until that process ever exited. Given the choice between a live-process
backup-and-restore and simply accepting the loss and reseeding fresh, the
explicit decision made was to restart clean: the accumulated dev/test data
had no durable value worth a riskier recovery attempt, and a fresh, verified
reseed (colony id 1 landing exactly at world center, matching the documented
Crit 10 invariant) was confirmed correct before continuing. This was never
an invocation of Reset World, and the real dev database's current state as
of this stage is that clean restart — not a recovery of whatever state
preceded it.

**Staged build order, verified incrementally.** Schema/migration first
(`accounts` table, the two new nullable columns, `bootstrapAdminAccount`),
verified against the full pre-existing suite with zero behavior change.
Password hashing and identity resolution next (`src/server/password.ts`,
`src/server/auth.ts`), as pure functions with their own direct-import unit
tests before anything touched HTTP. Auth routes and the one genuinely
behavior-changing edit — the `/api` middleware no longer being the only way
to resolve identity, since `GET /api/session` had to exist as a
non-minting read specifically so the entry gate could ask "who is this?"
without side effects — came only after that foundation was solid. Reset
Progress, the admin role/API, and the admin UI followed in that order so
each layer could be tested against a working layer beneath it rather than
all at once. Reset World's isolated-DB test suite and the entry/landing UI
came next, and WebSocket transition hardening (client reconnect-on-close,
plus a server-side test proving a login mid-connection is reflected on the
very next broadcast tick with no reconnect required) came last, closing the
same category of gap Stage 8 first identified for colony restarts.

**Tests needed one small adaptation, not a rewrite.** `colony.test.ts`,
`multiplayer.test.ts`, `realtime.test.ts`, and `world.test.ts` all gained a
single `POST /api/auth/guest` call before their first `/api/state` request —
the same colony/seed behavior as before, just an explicit call site now that
`/api/session` exists as the non-minting alternative. Nothing else in those
files needed to change, since every existing route still resolves identity
exactly the way it always has for a guest session.

## Stage 10: worker castes, and a fog-of-war revision

Stage 10's brief asked for two things: a durable per-worker caste
(worker/soldier/scout, each with its own base stats and a soldier that
can't gather) and fog of war. Castes were straightforward — `getEvolutionModifiers`'s
precedent (Stage 9) already showed the shape for "one central table of base
numbers, every call site reads a field instead of branching locally," so
`CASTE_BASE_STATS` just reused it. Fog of war is the part worth recording
in detail, because I built it twice, and the second build came from a real
measurement contradicting what I'd assumed the first time.

**First pass: fog as a server-side information boundary.** My first reading
of "fog of war" was literal: a colony shouldn't be *told* about what it
can't see, so `getState(colonyId)` computed a `getVisionSources(colonyId)` —
one circle per the colony's own queen and every one of its own living
workers — and filtered `otherWorkers`/`resourceNodes`/`creatures`/foreign
`colonies` through an `isVisible()` check before the payload ever left the
server. `issueGatherCommand`/`issueAttackCommand` also rejected a target
outright with `"target not visible"` if it wasn't currently in the caller's
vision. This read as the more defensible design — withhold at the source,
don't trust the client to self-censor — and it's what
([`d126617`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/d126617))
("Stage 10: worker castes, fog of war, and caste-aware evolution") actually
shipped first.

**The problem, observed manually, not from a test failure.** Running the
dev server for real play — two browser tabs, each its own colony, the
world accumulating colonies over several days of manual testing and
targeted test runs — produced noticeably laggy broadcasts as the number of
live colonies grew into the dozens. Nothing in the test suite caught this,
because `spec/`'s black-box tests never build a world at that scale; it
only showed up playing the actual game against the actual, multi-day-old
dev DB. The `getVisionSources`/`isVisible` filtering was the obvious
suspect: it was the one subsystem added this stage with no spatial index
and no prior performance budget, re-run from scratch on every
`getState()` call — once per distinct colony, per broadcast tick
(`broadcastState()`'s existing per-tick memoization, unchanged since
Crit 10) — unlike Stage 3's separation grid or Stage 7/9's own measured,
sub-millisecond `advanceSimulation()` costs.

**Why fog moved client-side instead of being optimized in place.** Before
reaching for a spatial index or caching vision sources, I reconsidered
whether server-side filtering was buying anything the brief actually
needed. It wasn't: the brief's security surface has only ever been about
*mutation* authority (Crit 10's session→colony model — who can move/
gather/attack what), never about withholding read-only world state from
the same browser already trusted to render it. There's no anti-cheat
requirement anywhere in this project, so a devtools user seeing the full
world in a client-side-fog design costs nothing the game actually needs.
Once visibility stopped being an information-security problem, it became a
much smaller rendering problem — and the client already had almost all of
the logic it needed: `drawFogOverlay()` already built the exact same
queen-plus-worker vision-circle punch-list server-side `getVisionSources`
did, purely to draw the darkness overlay on top of a world the server was
already filtering. The revision deletes the server-side filtering
entirely — `getState()` returns the full, unfiltered shared world to every
colony, same as every stage before this one — and makes that existing
client-side punch-list the single source of truth for what's drawn,
clickable (`hitTest()`), and darkened (`drawFogOverlay()`), so the three
can never drift out of sync with each other. `issueGatherCommand`/
`issueAttackCommand` drop the `"target not visible"` rejection; every other
check in those two functions (ownership, caste, busy, colony-active) is
untouched, since fog never had anything to do with command authorization in
the first place. A click into fog needed no new code at all — `onCanvasClick`
already fell through to a plain move command whenever `hitTest()` found
nothing, which is exactly what a hidden entity now also produces.

**Measuring it, rather than taking the lag report on faith.** I wrote a
throwaway script (not committed, following Stage 7/9's own precedent)
reconstructing the exact deleted `getVisionSources`/`isVisible` code from
`d126617` and comparing it against the current, unfiltered `getState()`
over a simulated broadcast tick (one `getState()` call per active colony,
matching `broadcastState()`'s own per-colony-per-tick shape), at two
different population shapes:

- Against the real, multi-day-accumulated dev DB (170 active colonies,
  heavily churned down by abandon/restart and combat testing to an average
  of under 3 workers per colony): removing fog filtering was a **~1.15x**
  speedup on `getState()` (old ~96ms/tick, new ~84ms/tick across all active
  colonies). Breaking that down further showed fog filtering itself
  accounted for only ~13% of the old total at this specific, atypical
  shape — the actual majority of the cost (~64%) was `getAllColonies()`'s
  pre-existing, Stage-9-introduced `population: getWorkersForColony(id).length`
  computation, an unrelated O(colonies × that colony's own workers) scan
  that fog never touched and this revision does not change. Worth a
  follow-up note in a later stage, but out of scope here.
- Against a population shaped like Stage 9's own precedent benchmark (30
  colonies, 20 workers each — closer to what a healthy, actively-played
  world looks like than the dev DB's churned-down shape): removing fog
  filtering was a **~2.0x** speedup (old ~6.0ms/tick, new ~3.0ms/tick).
  Scaling either dimension up (60 colonies × 20 workers, or 30 colonies ×
  40 workers) kept the speedup in the 1.2x–1.6x range and growing with
  population, consistent with the filtering cost's own
  `O(colonies × own_workers × world_entities)` shape compounding against
  whatever else `getState()` is doing.

The honest conclusion: fog filtering was real, measurable, avoidable
per-request cost that scales multiplicatively with colony count and has no
spatial index — exactly the category of thing worth removing on general
principle — but at the literal moment I went looking, a different,
unrelated pre-existing cost (`getAllColonies()`'s population scan) had grown
to dominate the picture more than fog had, specifically because of how
lopsided the dev DB's population had become after days of churn. This
doesn't change the design decision (removing server-side fog was still the
right simplification, since it bought nothing the brief needed in exchange
for its cost) but it does mean the lag I observed playing the game was
likely a combination of both costs, not purely the one I originally
suspected.

**Tests.** `spec/multiplayer.test.ts` and `spec/realtime.test.ts` both had
a scout-first-then-assert-visibility choreography woven through roughly a
dozen tests each, built specifically to exercise the now-deleted
server-side filtering (approach a hidden entity, assert it appears; command
a hidden target, assert `"target not visible"`). Both files were migrated
back to their pre-Stage-10 shape (the last commit before any fog-filtering
scaffolding existed, `0bc1e13`) rather than patched incrementally, since
the underlying mechanic the scouting setup existed to exercise no longer
exists server-side at all — the real, still-true contract is simply "every
session's own `/api/state`/WS payload already contains the full world,
unconditionally," which needs no setup to assert. The one genuine Stage 10
behavior preserved in the rewrite is `POST /api/reproduce`'s caste-aware
body (`{ caste: "worker" | "soldier" | "scout" }`, 400 on anything else) —
layered onto the otherwise fully pre-Stage-10 "two simultaneous reproduce
calls race for the same protein" test, since that's a genuine, unrelated
Stage 10 change this revision doesn't touch.

This revision — the fog-of-war rework, the test migrations, and the
CLAUDE.md/PROCESS.md documentation above — landed in one commit
([`1fe02d3`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/1fe02d3))
on top of `d126617`'s original server-side-fog version.

## Stage 9: evolution & colony specialisation

Stage 8 made colony growth survivable but still purely numerical: gather →
reproduce → more workers → do the same things with more workers, with
nothing to tell two colonies apart beyond raw size. This stage's brief
asked for a permanent, player-chosen identity attached to a colony's
*lineage*, not its session — three population milestones, three mixable
branches (Foraging/Survival/Brood), no prerequisites, no respec, and no way
for one colony's choices to leak into another's state or reopen PvP. I
started with three parallel read-only passes (schema/simulation/balance,
client/docs, the full spec suite) before writing anything, specifically to
find what Stage 8 already gave me rather than invent new idioms — and it
gave me more than expected: `defeatColony()`'s idempotent `UPDATE ... WHERE
status='active'` guard is the exact shape an exactly-once evolution
selection needs, and the inline-lifecycle-column pattern on `colonies` is
the exact shape three nullable tier columns need. The one genuine gap was
gathering itself: it was already real travel, but claim-on-arrival was
instantaneous, so "gather 30% faster" (Foraging II) had nothing to shorten
without inventing a small duration mechanic first.

Six commits, each green before the next.
The first
([`6b3c13f`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/6b3c13f))
is schema and constants: `peak_population` and three nullable
`evolution_tierN` columns on `colonies`, a guarded migration mirroring
`migrateColonyLifecycle()` exactly, and a new `evolution.ts` module whose
single `getEvolutionModifiers()` function is the only place all seven
derived numbers (carry yield, gather duration, two movement multipliers,
max health, attack damage, reproduce cost) get computed — every call site
elsewhere reads one field from it instead of branching on
`evolution.tier1 === "foraging"` locally. The second
([`525cc7f`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/525cc7f))
wires all three branches into the simulation: peak population is tracked
monotonically from `reproduce()` and never relocked by worker loss;
Foraging II's gather duration is a per-worker in-memory channel timer, the
same idiom the attack command's existing `cooldownRemaining` field already
uses, not a new persistence concept; Survival I is the one piece with no
prior art anywhere in the codebase — every existing max-health write sets
health to a fixed constant at creation, nothing had ever rescaled a live
worker's max health, so converting existing workers when the trait is
chosen needed its own percentage-preserving formula
(`newHealth = round((health / oldMax) * newMax)`), applied once inside the
same guarded transaction as the selection itself. Foraging III's
carry-speed bonus and Survival III's chase-speed bonus can never stack,
because the pre-existing `!worker.carrying` guard on `issueAttackCommand`
already makes carrying and attacking mutually exclusive — I confirmed this
is an inherited invariant, not something I had to add. The third
([`87d9e42`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/87d9e42))
adds the `POST /api/evolve` route and the realtime/public state fields
(`peakPopulation`, three `evolutionTierN` fields, `reproduceCost` on the
player's own colony; `population`/`peakPopulation`/`evolution`/
`defeatCause` on every roster entry), resolving `colonyId` from session
middleware only, same as every other mutating route. The fourth
([`96a9a53`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/96a9a53))
is the client: a non-blocking Evolution panel at the same modal tier as
Help, an availability badge, a confirm step before any permanent choice,
and an "Other colonies" list that satisfies the brief's ruin-history
requirement with a plain list driven by the existing roster rather than a
new canvas hover/tooltip system. The fifth
([`0bc1e13`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/0bc1e13))
is the test suite, including a new black-box `evolution.test.ts` for
cross-session authorization and the concurrent-selection race. The sixth
([`3c56a93`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/3c56a93))
documents all of it in `CLAUDE.md` and moves evolution from README's "not
here yet" into "what's here," tied to Juul's *emergence* — the same small,
fixed set of rules now producing colonies that diverge from each other by
player choice.

The full suite stands at 207/208, with `pnpm typecheck`/`pnpm
check:evidence` both green. One test (the same `otherWorkers`
spider-damage-visibility realtime assertion, pre-existing from an earlier
stage, untouched this stage beyond a cosmetic timeout-argument-position
change) failed under both a full-suite run and an isolated rerun; I
confirmed it is pre-existing flakiness, not a Stage 9 regression, by
reproducing the identical failure against a clean checkout of the
pre-Stage-9 commit (`72b2b8c`) with all Stage 9 work stashed out, then
restored the stash and re-ran the full suite clean (207/208, same single
failure) before committing documentation. A throwaway script measured
`advanceSimulation()` at full population (30 evolved colonies spanning
every branch and mixed builds, 690 workers, 62 creatures, under real
gather/attack commands exercising every Stage 9 per-tick branch) at
~0.72ms/tick average, still roughly 139x headroom under the 100ms budget —
higher than Stage 8's ~0.19ms/tick baseline, consistent with the 7.4x
increase in worker count (93 → 690) and sub-linear, not a design concern.

Production migration and manual Tier I acceptance (reaching 5 peak
population through ordinary gameplay on a real colony, via the live
browser UI rather than a scripted call) are deployment-stage work, reported
separately once CI is green and the deploy completes, per the same framing
Stage 8 used for its own post-deploy verification.

## Stage 8: queen survival, colony defeat & restart

Stage 7 made individual workers mortal but left the colony itself immortal:
a colony that lost every worker and couldn't scrape together 50 protein had
no way back — and that wasn't hypothetical, it was my own deployed colony,
stuck exactly that way. This stage's brief asked for the symmetric fix on
both ends: give the queen real health so a colony can actually be defeated
(by a spider, environmentally, never by another player), and give the
player an explicit, always-available way out (Abandon Colony → Start New
Colony) so a bad outcome is never permanent — without the shared world ever
resetting for anyone else in it. I started the same way as Stage 7: two
read-only passes over `simulation.ts`/`db.ts`/`sessions.ts` before writing
anything, specifically to find the existing idioms to extend rather than
invent new ones. That paid off directly — Stage 7's worker-health schema
pattern (inline columns + guarded `ALTER TABLE` + backfill), its
synchronous-damage discipline, and its nest-exclusion-asymmetry precedent
(a chase can enter a zone ambient wander never would) all transferred onto
the queen with no new idiom needed.

Five commits, each green before the next. The first
([`653ceb5`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/653ceb5))
is the core lifecycle: the colony schema gains `status`/`queen_health`/
`queen_max_health`/`defeat_cause`/`defeated_at` via the exact Stage 7
migration shape; the in-memory `nestPositions` map (a Stage 7 leftover
that only ever stored a position) is promoted to a proper `SimColony`
cache carrying health and status, which is what makes "a ruin protects
nothing" a one-line filter rather than a special case; spider targeting
gets a queen-aggro fallback that only runs once the existing worker scan
finds nothing, with its own named constants and deliberately no
nest-exclusion gate, so a queen is only ever threatened by a spider that
already chased or wandered its way in — never by a global "nearest
colony" search. `defeatColony()` is the one new function both a lethal hit
and a manual abandon call into: a single `UPDATE ... WHERE status='active'`
guard makes it idempotent by construction, so a race between two lethal
hits in the same tick, or a hit landing the same tick as a manual abandon,
still runs the worker/resource cleanup exactly once — proven in a test, not
just reasoned about.

The second
([`d45aac1`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/d45aac1))
is the player-facing half of the same mechanism: `abandon()` is a two-line
wrapper that calls `defeatColony()` with a different cause, which is the
entire guarantee that manual and environmental defeat can never drift
apart into two different cleanup paths. `startNewColony()` re-points a
session's existing row (an upsert, not a new history table — the old
colony simply persists, unreferenced, as the ruin) and is gated on the
session's *current* colony being defeated, never on resource balance, per
the brief. Writing this commit is also where I found a real bug rather
than a hypothetical one: the WebSocket broadcast loop cached a
connection's `colonyId` once at handshake, which was invisible and
harmless before Stage 8 (a session's colony never used to change) but
would have meant an already-open tab kept broadcasting a now-defeated
colony forever after a restart. The fix was to cache `sessionId` instead
and re-resolve `colonyId` fresh on every broadcast tick — same cost, one
extra indexed lookup per connection per tick. I only found this by writing
the realtime restart test first and watching it fail against the old
caching, not by auditing the code for it in the abstract.

The third
([`036a992`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/036a992))
is the client: health bars on every visible queen (reusing Stage 7's
`drawHealthBar` verbatim), a muted non-interactive ruin marker for a
defeated colony, an Abandon Colony confirmation modal using the brief's
exact required wording, and a defeat overlay with a Start New Colony
button that recenters the camera and clears selection on success with no
page reload anywhere in the flow. The fourth
([`fd839a2`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/fd839a2))
is the test suite: queen health/regen/targeting at the simulation level,
the defeat transaction's exactly-once guarantee and cleanup, the soft-lock
regression this whole stage exists to fix (zero workers, insufficient
protein, abandon, restart, playable again), two-session isolation
(one colony falling never touches another's state), and live WebSocket
broadcast of the full damage→defeat→ruin→restart sequence to both the
acting and an observing connection. The fifth
([`49d545a`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/49d545a))
documents all of it in `CLAUDE.md` as explicit invariants — including the
WebSocket bug and fix, named as a bug fix, not folded silently into "how
it works" — and moves queen death/defeat/restart and the new world event
feed from `README.md`'s "not here yet" into "what's here."

The full suite stands at 178/178, with `pnpm check`/`pnpm check:evidence`
both green. Two tests (a worker-injury realtime assertion and a cross-colony
attack-rejection assertion, both pre-existing from Stage 6/7, neither
touched this stage) failed once each under full-suite timing load; I
confirmed both are pre-existing flakiness, not a Stage 8 regression, by
reproducing the realtime one against a clean checkout of the pre-Stage-8
commit and by rerunning the attack-rejection one in isolation, where it
passed — then re-ran the full suite clean before committing documentation.
A throwaway script measured `advanceSimulation()` at full population (30
colonies, 93 workers, 10 spiders, under live attack commands including real
colony defeats occurring mid-measurement) at ~0.19ms/tick average, still
roughly 500x headroom under the 100ms budget — higher than Stage 7's
0.11ms baseline, which I attribute to the added queen-regen scan plus the
actual combat-driven defeats happening during the window, not a design
concern.

The brief's required acceptance evidence — recovering my own real,
deployed, soft-locked colony through the live Abandon Colony flow, with no
manual repair and no special-casing in code — is deployment-stage work,
not implementation-stage work, and is reported separately once that's
done, per the brief's own framing of it as post-deploy verification.

## Stage 7: predators and worker survival

Stage 6b made the ecosystem rich but risk-free: more workers were pure
upside, nothing could ever go wrong for one. This stage's brief asked for
exactly one hostile predator ("spider") plus real worker health/death, so
the loop becomes gather → risk → flee/fight → injury/death → carcass →
reproduce — with queens explicitly untouched (no HP, no death, no PvP) and
no colony-elimination path. I started from three read-only passes over the
existing creature/combat code before writing anything, because the brief's
own framing was "extend what Stage 5/6 already built, don't replace it,"
and the inspection confirmed that was fully possible: `creatures.species`
was already free text, combat was already a generic
`issueAttackCommand`/`applyDamage`/`killCreature` pipeline, and the one gap
was that nothing had ever attacked a worker.

Ten commits, each green before the next, roughly following the brief's own
suggested order. Step 1
([`27fa8ab`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/27fa8ab))
gives workers the exact same two-part health-schema contract
`creatures.health` already uses (inline columns for a fresh DB, a guarded
`ALTER TABLE` for an existing one, a backfill), threaded through both paths
that create a worker — reproduction and new-colony minting — so every
worker starts at full health from creation, not just from backfill. Step 2
([`dbcbb64`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/dbcbb64))
adds death itself: a worker's row is simply deleted, which is also the
entire "what happens to carried resources on death" rule — there's no
second code path that could duplicate or re-credit them, by construction
rather than by a guard. Step 3
([`70a5dd0`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/70a5dd0))
gives spiders a durable representation and a world population — scattered
rather than spawn-clustered, and kept further from every colony's spawn
than resources or aphids are (`SPIDER_CLEAR_RADIUS=400` vs.
`ANCHOR_CLEAR_RADIUS=120`) — plus the production-safe seeding split the
brief specifically asked for: a fresh world seeds spiders in the same pass
as everything else, while an already-populated (pre-Stage-7) world picks
them up exactly once, idempotently, the next time it boots, with no reset
and no manual script.

Step 4
([`003a9ff`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/003a9ff))
is the AI itself: a new ephemeral `chase` command, the aphid wander state
machine generalized into a shared species-parameterized `advanceWander`,
and `advanceSpider`'s aggro scan (ownership-blind, deterministic
nearest-plus-id-tiebreak target selection) with disengage-on-range and
attack-on-cooldown. Steps 5 and 6 from the brief's suggested order
(damage/death wiring and the player-attacks-spider path) turned out to
already be exercised for free by the generic combat pipeline once spiders
existed as creatures, so they're folded into step 4's tests rather than
needing their own commits — confirmed, not assumed, by the tests that
cover them. Step 7
([`64dd0a4`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/64dd0a4))
generalizes carcass/loot lookup off a per-species map instead of a
hardcoded aphid constant, adds the `spider_died` log line gated on species
so aphid-combat output is unchanged, and adds the no-PvP regression test
the brief asked for: proving a worker id can never resolve as an attack
target against another colony's worker, because the attack path only ever
looks workers up in the `creatures` table.

Step 8
([`3f15fc9`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/3f15fc9))
extended multiplayer/realtime coverage to spiders — shared visibility,
independent concurrent attacks, injury/death over both HTTP and WebSocket
— and in the process of writing the concurrent-kill test, surfaced a real
bug rather than a hypothetical one: a spider's unconstrained ambient wander
could drift into a colony's spawn and kill freshly-minted, unclaimed
workers, a de facto colony elimination the brief explicitly forbids. My
first fix attempt (reject a wander step and hold position) had its own
failure mode — a spider already inside a clear zone via a chase that ended
there could camp there indefinitely — so I replaced it with stepping
directly away from the nearest violating nest, which is RNG-free and
always makes forward progress. Step 9
([`1568ee6`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/1568ee6))
is the client half (spider marker, click radius, worker health bars, a new
Help "Danger" section) plus a second instance of the same class of bug:
constraining wander *endpoints* to stay outside a nest's clear zone isn't
enough, because the straight-line path between two clear endpoints can
still cut through the zone in between. I found this empirically, by
correlating the dev log's `colony_claimed {"workerCount":0}` against a
spider's recent chase history, not by reasoning about it in the abstract.
The real fix is at the trigger, not the path: `advanceSpider`'s aggro scan
now skips any worker standing inside a clear zone, so a spider can never
*initiate* a chase there regardless of how it arrived nearby — a chase
already in progress is deliberately left unconstrained, so a worker
fleeing home can still be caught.

Step 10
([`deb9381`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/deb9381),
wording clarified in
[`9d206d9`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-u7488099/commit/9d206d9))
is verification and documentation. The brief asked for a measurement, not
an assumption, of the 10 Hz tick budget at full population — I wrote a
throwaway script that scaled the world to 93 workers and 62 creatures
across 31 colonies, had every worker issue a real attack command against a
spider so the timed workload was actual combat computation rather than
idle wander, and timed 500 ticks of `advanceSimulation()` with
`process.hrtime.bigint()`: ~0.11ms/tick average against a 100ms budget,
roughly 900x headroom, confirming the aggro scan's O(spiders × workers)
cost is trivial at this scale. For restart/persistence, I judged the
existing species-agnostic `killWorker`/`loadSimulation()` test coverage
(Stage 6's generic creature-restart tests plus the dedicated worker-health
restart test added in step 2) sufficient without a spider-specific
duplicate, since none of that code branches on species — consistent with
this project's standing preference against mechanically-generated,
redundant tests. `CLAUDE.md` gained a full Stage 7 section documenting all
of the above as explicit invariants (queen immunity and no-PvP as
structural properties, not guard clauses; the two-layered nest-exclusion
mechanism and why the first layer alone was insufficient), and `README.md`
moved predators/worker-death out of "not here yet" into "what's here."

The full suite stands at 134/134 with `pnpm check`/`pnpm check:evidence`
both green, verified against a freshly reset dev DB immediately before
each of the last two commits.

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
