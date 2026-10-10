# Crit 9

**What was the breakthrough that moved the work forward?**

Realising that the brief's required multi-user decision wasn't a prose
question to answer after the fact — it was something I could actually go
verify. Instead of reasoning in the abstract about what happens when two
people act on the colony at once, I wrote a test for the exact race (two
simultaneous `reproduce` calls competing for the same protein) before I'd
decided what to say about it, and watched it already pass. The decision
("the server is the single authority, clients never resolve conflicts
themselves") came out of that result, not the other way around. It changed
the order I work in: write the test for the claim, then make the claim,
not the reverse.

The second breakthrough was smaller but cost me real time to find: a second
spec file that mutates the same shared colony as last week's broke the old
test intermittently, and the cause wasn't my code — Vitest's default file
ordering turned out to be a cache/size heuristic, not alphabetical, so which
file ran first wasn't deterministic. I didn't accept "it's flaky" as an
answer; I went and read the sequencer's actual source until I understood
why, then fixed the real cause (a path-ordered sequencer) instead of
reaching for a workaround like isolating the tests or adding retries.

**What did this work change about who I want to be as a software developer?**

The brief says my pod will be asked to argue for the multi-user option I
didn't pick, which meant the decision had to be mine in a way that would
hold up out loud, not just a plausible paragraph. I caught myself about to
let the agent pick one of the four candidate decisions for me "since they're
all reasonable" — and stopped, because defending a decision I don't
actually believe is worse than making a smaller one I do. Choosing the
topic myself, then using the agent to verify the technical fact underneath
it rather than write the justification, felt like the right split of labour
to keep.
