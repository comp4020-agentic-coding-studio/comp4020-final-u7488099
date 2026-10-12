# Crit 10

**What was the breakthrough that moved the work forward?**

I'd assumed "give each session its own colony" was the whole architecture,
and started implementing it as a straightforward lazy-creation flow: no
cookie, mint a colony, done. The red spec file I wasn't allowed to touch
caught something I hadn't actually thought through — a test that fetches
alice's state, then bob's, then checks that alice's *own* response already
lists bob's colony in the shared roster. My first instinct was that this
had to be a flaw in the test's ordering, since bob's colony plainly didn't
exist yet when alice's request was served. It took sitting with that
discomfort for a while — re-reading the test rather than assuming it was
wrong — before I saw that the test wasn't describing a race, it was
describing a requirement: the world has to stay one step ahead of whoever
joins it next. The fix (always keep one spare, pre-minted colony sitting
unclaimed, so a session's own response already contains the colony the very
next joiner will get) only became obvious once I stopped treating the test
as an obstacle to route around and started treating it as the actual spec
for a behaviour I hadn't designed for yet.

The second one was quieter but just as real: I redesigned the WebSocket
broadcast to compute `getState(colonyId)` per connection, which felt like
the obviously correct per-colony analogue of the old single shared payload.
It broke a test I'd assumed would just keep passing — two connections to
the same colony seeing byte-identical state. Diffing my new code against
`git show HEAD:src/server/index.ts` rather than guessing showed the
original never recomputed state per client at all; it computed once per
tick and fanned out the same string. My "obviously correct" version had
quietly dropped an invariant the original architecture gave me for free.

**What did this work change about who I want to be as a software developer?**

Both of these were cases where a test I was forbidden to weaken was, in
effect, more right than my first read of the requirements. The rule not to
touch `spec/multiplayer.test.ts` could have felt like a constraint to work
around; instead it forced me to actually resolve the disagreement between
what I'd built and what the test expected, rather than settling for "the
test must be wrong" the moment my code didn't match it. I want to keep that
instinct — when a spec I trust and my implementation disagree, assume the
spec is teaching me something about the design before assuming it's a bug
in the spec.
