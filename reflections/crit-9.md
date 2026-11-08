# Crit 9 Reflection — All at Once

For Crit 9, I focused on making Colony realtime and deciding what should happen when multiple actions reach the server at nearly the same time. The previous version already had persistent state, but it still behaved more like a collection of requests than a continuously running game.

I introduced WebSockets so that the server could push updates to connected browsers without requiring them to refresh. I chose this over repeated polling because I expected the game to involve frequent movement and state changes. A shared world would not feel very convincing if different players were constantly looking at outdated versions of it.

The other important part was concurrency. I used reproduction as a concrete example because it involves spending a limited resource. If a colony had enough protein for only one worker and two reproduction commands arrived together, only one should succeed. Otherwise, the game would effectively create resources from nothing. Rather than reason about this in the abstract, I wrote a test for the exact race — two simultaneous reproduce calls competing for the same protein — before deciding what the rule should be, and let the test's result justify the decision rather than the other way around.

I decided to keep the server authoritative over state changes. Clients could request reproduction, but the server would check the current resources and decide whether the request was valid. Since the application was running on one Node.js server, I could keep the critical mutation path synchronous rather than introducing a more complicated distributed locking system. The brief requires my pod to argue for whichever multi-user option I didn't pick, so I made a point of choosing this decision myself rather than letting Claude pick one of the reasonable alternatives for me — I wanted it to be something I actually believed, not just a plausible paragraph.

A second, smaller problem cost me real time: a new spec file that mutated the same shared colony as an older one started breaking that older test intermittently. It wasn't my application code — Vitest's default file ordering is a cache/size heuristic, not alphabetical, so which spec file ran first wasn't deterministic. I read the test runner's own sequencing logic until I understood the actual cause, then fixed it with a custom path-ordered test sequencer rather than papering over it with retries.

This made me think more carefully about the difference between realtime updates and correct shared state. WebSockets can make changes appear quickly, but that does not automatically mean the underlying decisions are consistent. If two browsers see an impossible result, displaying it immediately does not make the application good.

I also learned that automated tests were particularly useful for problems that were difficult to reproduce manually. Clicking twice quickly in a browser was not a reliable way to test concurrency. Sending competing requests and checking the final state gave me much stronger evidence that the server behaved correctly.

Claude Code was useful for implementing the WebSocket connection and writing the tests, but the main design decision — what consistency should mean for the game — was mine. I wanted every action to have one authoritative result that all connected players could observe.

At the end of this crit, Colony had a much better technical foundation for multiplayer. However, it still did not properly distinguish different players and their colonies. The next challenge was to make the shared world genuinely multi-user, where each person had their own identity and could affect the same environment without controlling someone else's units.
