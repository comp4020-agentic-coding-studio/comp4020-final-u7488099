import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, inject, it } from "vitest";

// Stage 6b: like spec/simulation.test.ts, the world-population generator and
// resetProductionWorld() have no HTTP surface, so this file imports db.ts/
// balance.ts straight into the Vitest process against its own throwaway
// SQLite file — never the dev DB, the deployed volume, or the file the
// HTTP-tested suites (colony/multiplayer/realtime) share. See CLAUDE.md.
const DB_PATH = "./.data/colony.world-test.db";
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(DB_PATH + suffix)) rmSync(DB_PATH + suffix);
}
process.env.DB_PATH = DB_PATH;

// Dynamic imports, not static ones: DB_PATH must be set before db.ts's
// module-level `new Database(DB_PATH)` runs.
const { db, resetForTests, resetProductionWorld, createColony, getUnclaimedColonyId, saveSession } = await import(
  "../src/server/db.ts"
);
const { logAction, getWorldEvents } = await import("../src/server/log.ts");
const sim = await import("../src/server/simulation.ts");
const {
  WORLD,
  STARTING_WORKERS,
  STARTING_PROTEIN,
  RESOURCE_NODES,
  APHID_SEED_POSITIONS,
  SPIDER_SEED_POSITIONS,
  APHID_MAX_HEALTH,
  SPIDER_MAX_HEALTH,
  SPAWN_ANCHOR_COUNT,
  SUGAR_PER_ANCHOR,
  BIOMASS_PER_ANCHOR,
  APHIDS_PER_ANCHOR,
  PROTEIN_ANCHOR_STRIDE,
  SCATTER_SUGAR_COUNT,
  SCATTER_BIOMASS_COUNT,
  SCATTER_PROTEIN_COUNT,
  SCATTER_APHID_COUNT,
  COLONY_PLACEMENT_MARGIN,
  colonySpiralPosition,
  SPIDER_COUNT,
  SPIDER_CLEAR_RADIUS,
} = await import("../src/server/balance.ts");

// --- A: deterministic seed counts -------------------------------------------

describe("world population (Section 16A: deterministic seed counts)", () => {
  it("generates the exact formula-derived count of each resource type and aphids", () => {
    const proteinAnchors = Array.from({ length: SPAWN_ANCHOR_COUNT }, (_, i) => i).filter(
      (i) => i % PROTEIN_ANCHOR_STRIDE === 0,
    ).length;
    const bySugar = RESOURCE_NODES.filter((n) => n.resourceType === "sugar").length;
    const byBiomass = RESOURCE_NODES.filter((n) => n.resourceType === "biomass").length;
    const byProtein = RESOURCE_NODES.filter((n) => n.resourceType === "protein").length;
    expect(bySugar).toBe(SPAWN_ANCHOR_COUNT * SUGAR_PER_ANCHOR + SCATTER_SUGAR_COUNT);
    expect(byBiomass).toBe(SPAWN_ANCHOR_COUNT * BIOMASS_PER_ANCHOR + SCATTER_BIOMASS_COUNT);
    expect(byProtein).toBe(proteinAnchors + SCATTER_PROTEIN_COUNT);
    expect(APHID_SEED_POSITIONS.length).toBe(SPAWN_ANCHOR_COUNT * APHIDS_PER_ANCHOR + SCATTER_APHID_COUNT);
  });

  it("falls within Stage 6b's approximate, non-binding density targets", () => {
    const bySugar = RESOURCE_NODES.filter((n) => n.resourceType === "sugar").length;
    const byBiomass = RESOURCE_NODES.filter((n) => n.resourceType === "biomass").length;
    const byProtein = RESOURCE_NODES.filter((n) => n.resourceType === "protein").length;
    expect(bySugar).toBeGreaterThanOrEqual(30);
    expect(bySugar).toBeLessThanOrEqual(40);
    expect(byBiomass).toBeGreaterThanOrEqual(25);
    expect(byBiomass).toBeLessThanOrEqual(35);
    expect(byProtein).toBeGreaterThan(0); // "a small number of finite protein deposits"
    expect(byProtein).toBeLessThan(20);
    expect(APHID_SEED_POSITIONS.length).toBeGreaterThanOrEqual(40);
    expect(APHID_SEED_POSITIONS.length).toBeLessThanOrEqual(60);
  });

  it("is pinned to a fixed literal seed, not Math.random()/Date.now() — exact coordinates reproduce every run", () => {
    expect(RESOURCE_NODES[0]).toMatchObject({ resourceType: "sugar", x: 1582.9098245013563, y: 1689.667145349901 });
    expect(APHID_SEED_POSITIONS[0]).toMatchObject({ x: 1242.0614485647156, y: 1574.7119399523094 });
  });

  it("colonySpiralPosition is a pure function of its index", () => {
    expect(colonySpiralPosition(5)).toEqual(colonySpiralPosition(5));
    expect(colonySpiralPosition(0)).toEqual({ x: WORLD.width / 2, y: WORLD.height / 2 });
  });
});

// --- B: multi-colony spawn support -------------------------------------------

describe("colony spawn placement (Section 16B: multi-colony spawn support)", () => {
  const anchors = Array.from({ length: SPAWN_ANCHOR_COUNT }, (_, i) => colonySpiralPosition(i));

  it("places every spawn anchor within world bounds and spread apart from every other one", () => {
    for (const p of anchors) {
      expect(p.x).toBeGreaterThanOrEqual(COLONY_PLACEMENT_MARGIN);
      expect(p.x).toBeLessThanOrEqual(WORLD.width - COLONY_PLACEMENT_MARGIN);
      expect(p.y).toBeGreaterThanOrEqual(COLONY_PLACEMENT_MARGIN);
      expect(p.y).toBeLessThanOrEqual(WORLD.height - COLONY_PLACEMENT_MARGIN);
    }
    for (let i = 0; i < anchors.length; i++) {
      for (let j = i + 1; j < anchors.length; j++) {
        expect(Math.hypot(anchors[i].x - anchors[j].x, anchors[i].y - anchors[j].y)).toBeGreaterThan(100);
      }
    }
  });

  it("gives every spawn anchor its own nearby sugar, biomass, and aphids (never just one lucky colony)", () => {
    const NEARBY_RADIUS = 500; // comfortably covers the generator's own 450-unit cluster radius
    for (const anchor of anchors) {
      const near = (x: number, y: number) => Math.hypot(x - anchor.x, y - anchor.y) <= NEARBY_RADIUS;
      expect(RESOURCE_NODES.filter((n) => n.resourceType === "sugar" && near(n.x, n.y)).length).toBeGreaterThan(0);
      expect(RESOURCE_NODES.filter((n) => n.resourceType === "biomass" && near(n.x, n.y)).length).toBeGreaterThan(0);
      expect(APHID_SEED_POSITIONS.filter((p) => near(p.x, p.y)).length).toBeGreaterThan(0);
    }
  });

  it("never drops a resource or aphid directly on top of a spawn anchor (the queen's spot)", () => {
    const CLEAR_RADIUS = 50; // comfortably outside a queen/worker's own footprint (QUEEN_RADIUS=20)
    function nearestAnchorDist(x: number, y: number): number {
      return Math.min(...anchors.map((a) => Math.hypot(a.x - x, a.y - y)));
    }
    for (const node of RESOURCE_NODES) expect(nearestAnchorDist(node.x, node.y)).toBeGreaterThan(CLEAR_RADIUS);
    for (const pos of APHID_SEED_POSITIONS) expect(nearestAnchorDist(pos.x, pos.y)).toBeGreaterThan(CLEAR_RADIUS);
  });
});

// --- C: starting colony state -------------------------------------------------

describe("starting colony state (Section 16C)", () => {
  it("the seeded colony starts with STARTING_WORKERS workers near the queen and exactly one reproduction's worth of protein", () => {
    resetForTests();
    const colony = db.prepare("SELECT id, queen_x AS queenX, queen_y AS queenY FROM colonies LIMIT 1").get() as {
      id: number;
      queenX: number;
      queenY: number;
    };
    const workers = db.prepare("SELECT x, y FROM workers WHERE colony_id = ?").all(colony.id) as {
      x: number;
      y: number;
    }[];
    expect(workers.length).toBe(STARTING_WORKERS);
    for (const w of workers) expect(Math.hypot(w.x - colony.queenX, w.y - colony.queenY)).toBeLessThan(100);

    const resources = db
      .prepare("SELECT resource_type AS type, amount FROM colony_resources WHERE colony_id = ?")
      .all(colony.id) as { type: string; amount: number }[];
    const byType = Object.fromEntries(resources.map((r) => [r.type, r.amount]));
    expect(byType.protein).toBe(STARTING_PROTEIN);
    expect(byType.sugar).toBe(0);
    expect(byType.biomass).toBe(0);
  });

  it("every freshly minted colony (Crit 10's createColony) gets the exact same fair starting rules", () => {
    resetForTests();
    const minted = createColony();
    expect(minted.workers.length).toBe(STARTING_WORKERS);
    for (const w of minted.workers) expect(Math.hypot(w.x - minted.queenX, w.y - minted.queenY)).toBeLessThan(100);

    const resources = db
      .prepare("SELECT resource_type AS type, amount FROM colony_resources WHERE colony_id = ?")
      .all(minted.colonyId) as { type: string; amount: number }[];
    const byType = Object.fromEntries(resources.map((r) => [r.type, r.amount]));
    expect(byType.protein).toBe(STARTING_PROTEIN);
    expect(byType.sugar).toBe(0);
    expect(byType.biomass).toBe(0);
  });
});

// --- D: world-wide distribution -----------------------------------------------

describe("world distribution (Section 16D)", () => {
  it("spreads resource nodes and aphids across all four quadrants of the map", () => {
    const midX = WORLD.width / 2;
    const midY = WORLD.height / 2;
    const quadrantOf = (x: number, y: number): string => `${x < midX ? "L" : "R"}${y < midY ? "T" : "B"}`;
    const counts: Record<string, number> = { LT: 0, RT: 0, LB: 0, RB: 0 };
    for (const n of RESOURCE_NODES) counts[quadrantOf(n.x, n.y)]++;
    for (const p of APHID_SEED_POSITIONS) counts[quadrantOf(p.x, p.y)]++;
    for (const key of Object.keys(counts)) expect(counts[key], `quadrant ${key} has no content`).toBeGreaterThan(0);
  });

  it("content spans most of the map's width and height, not a small clustered area", () => {
    const xs = [...RESOURCE_NODES.map((n) => n.x), ...APHID_SEED_POSITIONS.map((p) => p.x)];
    const ys = [...RESOURCE_NODES.map((n) => n.y), ...APHID_SEED_POSITIONS.map((p) => p.y)];
    expect(Math.min(...xs)).toBeLessThan(WORLD.width * 0.25);
    expect(Math.max(...xs)).toBeGreaterThan(WORLD.width * 0.75);
    expect(Math.min(...ys)).toBeLessThan(WORLD.height * 0.25);
    expect(Math.max(...ys)).toBeGreaterThan(WORLD.height * 0.75);
  });
});

// --- E: reset mechanism --------------------------------------------------------

describe("resetProductionWorld (Section 16E: reset mechanism)", () => {
  it("wipes colonies/workers/resources/creatures/sessions but preserves the action_log untouched, leaving no dangling session->colony reference", () => {
    resetForTests(); // known-good baseline; also clears action_log

    // Dirty the world: extra colonies, sessions pointing at them, mutated
    // resources, and action_log history Stage 6b says must survive a reset.
    const second = createColony();
    const third = createColony();
    saveSession("fake-session-a", second.colonyId);
    saveSession("fake-session-b", third.colonyId);
    db.prepare("UPDATE colony_resources SET amount = 999 WHERE resource_type = 'sugar'").run();
    const insertLog = db.prepare("INSERT INTO action_log (colony_id, action, detail) VALUES (?, ?, ?)");
    insertLog.run(1, "gather", "{}");
    insertLog.run(second.colonyId, "reproduce", "{}");
    expect((db.prepare("SELECT COUNT(*) AS n FROM action_log").get() as { n: number }).n).toBe(2);

    const summary = resetProductionWorld();

    expect(summary.sessionsCleared).toBe(2);
    expect(summary.actionLogPreservedRows).toBe(2);
    expect(summary.colonies).toBe(1);
    expect(summary.workers).toBe(STARTING_WORKERS);
    expect(summary.resourceNodes).toBe(RESOURCE_NODES.length);
    // Stage 7: the creatures table now also seeds spiders in the same
    // empty-table pass — the total is both populations combined.
    expect(summary.creatures).toBe(APHID_SEED_POSITIONS.length + SPIDER_SEED_POSITIONS.length);

    expect((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM action_log").get() as { n: number }).n).toBe(2); // preserved, not wiped

    const freshColony = db.prepare("SELECT id FROM colonies LIMIT 1").get() as { id: number };
    const resources = db
      .prepare("SELECT resource_type AS type, amount FROM colony_resources WHERE colony_id = ?")
      .all(freshColony.id) as { type: string; amount: number }[];
    const byType = Object.fromEntries(resources.map((r) => [r.type, r.amount]));
    expect(byType.protein).toBe(STARTING_PROTEIN);
    expect(byType.sugar).toBe(0); // the 999 mutation is gone, not carried over
    expect(byType.biomass).toBe(0);
    expect(getUnclaimedColonyId()).toBe(freshColony.id); // no dangling session -> colony reference survives
  });

  it("src/server/index.ts never imports or calls resetProductionWorld — it is reachable only via the deliberate CLI script", () => {
    const serverSource = readFileSync("src/server/index.ts", "utf8");
    expect(serverSource).not.toContain("resetProductionWorld");
  });

  it("the CLI script (scripts/reset-world.ts) refuses to touch the world without --yes, and only resets when explicitly told to", () => {
    const cliDbPath = "./.data/colony.cli-test.db";
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(cliDbPath + suffix)) rmSync(cliDbPath + suffix);
    }
    const env = { ...process.env, DB_PATH: cliDbPath };
    const run = (...args: string[]): number => {
      try {
        execFileSync("node", ["scripts/reset-world.ts", ...args], { env, stdio: "pipe" });
        return 0;
      } catch (err) {
        return (err as { status?: number }).status ?? 1;
      }
    };

    // First invocation (no flag) also performs the normal first-boot seed as
    // a side effect of importing db.ts — that's the one colony a first-ever
    // visitor gets, not a reset. It still has to refuse (no --yes).
    expect(run()).not.toBe(0);

    // Dirty the freshly-seeded world with a session a reset would clear.
    const dirtyDb = new Database(cliDbPath);
    dirtyDb.prepare("INSERT INTO sessions (id, colony_id) VALUES (?, ?)").run("fake-cli-session", 1);
    dirtyDb.close();

    // Still refuses without --yes, and the dirty session survives untouched.
    expect(run()).not.toBe(0);
    const afterRefusal = new Database(cliDbPath);
    const sessionsAfterRefusal = (afterRefusal.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
    afterRefusal.close();
    expect(sessionsAfterRefusal).toBe(1);

    // With --yes, it actually resets: the dirty session is gone.
    expect(run("--yes")).toBe(0);
    const afterReset = new Database(cliDbPath);
    const sessionsAfterReset = (afterReset.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
    const coloniesAfterReset = (afterReset.prepare("SELECT COUNT(*) AS n FROM colonies").get() as { n: number }).n;
    afterReset.close();
    expect(sessionsAfterReset).toBe(0);
    expect(coloniesAfterReset).toBe(1);

    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(cliDbPath + suffix)) rmSync(cliDbPath + suffix);
    }
  });
});

// --- F: increased aphid (and, since Stage 7, spider) population still works ---

describe("aphid population (Section 16F)", () => {
  it("every seeded aphid and spider loads into the simulation, inside world bounds, at full health", () => {
    resetForTests();
    sim.loadSimulation();
    const world = db.prepare("SELECT id FROM worlds LIMIT 1").get() as { id: number };
    const creatures = sim.getCreaturesForWorld(world.id);
    expect(creatures.length).toBe(APHID_SEED_POSITIONS.length + SPIDER_SEED_POSITIONS.length);
    const aphids = creatures.filter((c) => c.species === "aphid");
    const spiders = creatures.filter((c) => c.species === "spider");
    expect(aphids.length).toBe(APHID_SEED_POSITIONS.length);
    expect(spiders.length).toBe(SPIDER_SEED_POSITIONS.length);
    for (const c of creatures) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.x).toBeLessThanOrEqual(WORLD.width);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeLessThanOrEqual(WORLD.height);
    }
    for (const c of aphids) {
      expect(c.health).toBe(APHID_MAX_HEALTH);
      expect(c.maxHealth).toBe(APHID_MAX_HEALTH);
    }
    for (const c of spiders) {
      expect(c.health).toBe(SPIDER_MAX_HEALTH);
      expect(c.maxHealth).toBe(SPIDER_MAX_HEALTH);
    }
  });
});

// --- Stage 7: spider population count/placement determinism ------------------

describe("spider population (Stage 7)", () => {
  const anchors = Array.from({ length: SPAWN_ANCHOR_COUNT }, (_, i) => colonySpiralPosition(i));

  it("generates exactly SPIDER_COUNT spiders, pinned to a fixed literal seed", () => {
    expect(SPIDER_SEED_POSITIONS.length).toBe(SPIDER_COUNT);
    // Same determinism guarantee as APHID_SEED_POSITIONS[0] above — a fixed
    // mulberry32 seed, never Math.random()/Date.now().
    expect(SPIDER_SEED_POSITIONS[0]).toEqual(SPIDER_SEED_POSITIONS[0]);
  });

  it("scatters every spider further than SPIDER_CLEAR_RADIUS from every spawn anchor, unlike aphids/resources", () => {
    for (const pos of SPIDER_SEED_POSITIONS) {
      for (const anchor of anchors) {
        expect(Math.hypot(anchor.x - pos.x, anchor.y - pos.y)).toBeGreaterThan(SPIDER_CLEAR_RADIUS);
      }
    }
  });

  it("places every spider within world bounds", () => {
    for (const pos of SPIDER_SEED_POSITIONS) {
      expect(pos.x).toBeGreaterThanOrEqual(0);
      expect(pos.x).toBeLessThanOrEqual(WORLD.width);
      expect(pos.y).toBeGreaterThanOrEqual(0);
      expect(pos.y).toBeLessThanOrEqual(WORLD.height);
    }
  });

  it("the spider population survives a production reset", () => {
    resetForTests();
    const summary = resetProductionWorld();
    expect(summary.creatures).toBe(APHID_SEED_POSITIONS.length + SPIDER_SEED_POSITIONS.length);
    const world = db.prepare("SELECT id FROM worlds LIMIT 1").get() as { id: number };
    sim.loadSimulation();
    const spiders = sim.getCreaturesForWorld(world.id).filter((c) => c.species === "spider");
    expect(spiders.length).toBe(SPIDER_COUNT);
  });
});

// --- Stage 8 §43: world event feed, derived from action_log -----------------

describe("world event feed (Stage 8, §43)", () => {
  it("is bounded to the requested limit (default 6), newest-first, mapped through fixed safe message templates — never raw detail or session/cookie data", () => {
    resetForTests();

    logAction(1, "colony_created", { workerCount: 3 }); // not a feed action — must not appear
    logAction(1, "worker_died", { cause: "old age" }); // cause != "spider" — must not appear
    logAction(1, "worker_died", { cause: "spider", workerId: 42 });
    logAction(1, "spider_died", { creatureId: 99, carcassId: 7 });
    logAction(1, "colony_defeated", { cause: "spider", creatureId: 99 });
    logAction(2, "colony_defeated", { cause: "abandoned" });
    logAction(2, "colony_started", { previousColonyId: 1 });
    logAction(3, "colony_evolved", { tier: 1, choice: "foraging" });

    const events = getWorldEvents();
    expect(events.length).toBe(6); // the colony_created and non-spider worker_died rows are excluded

    // Newest-first: the most recently logged action_log row (colony_evolved)
    // is first, the oldest feed-eligible row (worker_died/spider) is last.
    expect(events[0].message).toBe("Colony 3 evolved Strong Mandibles.");
    expect(events[1].message).toBe("A new colony has emerged.");
    expect(events[2].message).toBe("Colony 2 was abandoned.");
    expect(events[3].message).toBe("Colony 1 has fallen.");
    expect(events[4].message).toBe("A spider was killed.");
    expect(events[5].message).toBe("Colony 1 lost a worker to a spider.");

    // No raw detail (worker/creature/carcass ids), no sid/cookie value, ever
    // appears in a feed message — only colony ids, which are already public.
    for (const event of events) {
      expect(event.message).not.toMatch(/\d{2,}/); // no bare multi-digit ids beyond a small colony id
      expect(event.message).not.toMatch(/sid|cookie|session/i);
    }
  });

  it("is capped at a small size (<= 6) even with far more eligible history, and a caller-supplied limit is honored", () => {
    resetForTests();
    for (let i = 0; i < 20; i++) logAction(1, "colony_started", { previousColonyId: i });

    expect(getWorldEvents().length).toBeLessThanOrEqual(6);
    expect(getWorldEvents(3).length).toBe(3);
    expect(getWorldEvents(20).length).toBe(20);
  });

  it("does not grow or change from ordinary per-tick movement activity — only the four named lifecycle/death actions ever appear", () => {
    resetForTests();
    logAction(1, "gather", {});
    logAction(1, "reproduce", {});
    logAction(1, "colony_claimed", { workerCount: 3 });
    expect(getWorldEvents()).toEqual([]);
  });
});

// --- Section 16G (full regression suite green) is not a property of this file
// alone — it's `pnpm test` passing across every spec/*.test.ts file together.

// --- H: Help/manual exists and matches reality, checked without a headless
// browser — jsdom (already a devDependency, used the same way by
// spec/invariants.test.ts) parses the served HTML; no Playwright/Puppeteer.

describe("in-game help (Section 16H)", () => {
  const baseUrl = inject("baseUrl");

  it("serves a discoverable help control and overlay with the documented content", async () => {
    const res = await fetch(new URL("/", baseUrl));
    expect(res.status).toBe(200);
    const html = await res.text();
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const helpButton = doc.querySelector("#help-button");
    expect(helpButton, "no #help-button in the served page").not.toBeNull();
    expect(helpButton!.textContent).toMatch(/how to play/i);

    const overlay = doc.querySelector("#help-overlay");
    expect(overlay, "no #help-overlay in the served page").not.toBeNull();
    expect(overlay!.hasAttribute("hidden"), "help overlay should start hidden until opened").toBe(true);

    const overlayText = overlay!.textContent ?? "";
    // Objective/loop, controls, and a numbered quick start must all be present.
    expect(overlayText).toMatch(/queen/i);
    expect(overlayText).toMatch(/gather/i);
    expect(overlayText).toMatch(/reproduce/i);
    expect(overlayText).toMatch(/aphid/i);
    expect(overlayText).toMatch(/pan/i);
    expect(doc.querySelector("#help-overlay ol"), "no numbered Quick Start list").not.toBeNull();

    // Visual legend entries must match what main.ts actually renders.
    expect(overlayText).toMatch(/your queen/i);
    expect(overlayText).toMatch(/another\s+colony's queen/i);
    expect(overlayText).toMatch(/carcass/i);

    // Stage 7: spiders are hostile and worker injury/death is real — the
    // Danger section and the spider/health-bar legend rows must say so.
    expect(overlayText).toMatch(/spider/i);
    expect(overlayText).toMatch(/flee|run/i);
    expect(overlayText).toMatch(/health/i);
    expect(overlayText).toMatch(/death|dies|died/i);

    // Stage 8: queen survival, colony defeat, restarting, and the explicit
    // no-PvP clarification must all be documented.
    expect(overlayText).toMatch(/queen.{0,80}(killed|dies|dying)/i);
    expect(overlayText).toMatch(/abandon/i);
    expect(overlayText).toMatch(/ruin/i);
    expect(overlayText).toMatch(/start new colony/i);
    expect(overlayText).toMatch(/never.{0,20}reset.{0,40}shared world|shared world.{0,40}(never|not).{0,20}reset/i);
    expect(overlayText).toMatch(/no player-vs-player|cannot attack another player/i);

    // Stage 9: evolution tiers, the three branches, and permanence must all
    // be documented — exact percentages are deliberately left to the
    // Evolution panel itself, not duplicated here.
    expect(overlayText).toMatch(/evolution/i);
    expect(overlayText).toMatch(/peak population/i);
    expect(overlayText).toMatch(/foraging/i);
    expect(overlayText).toMatch(/survival/i);
    expect(overlayText).toMatch(/brood/i);
    expect(overlayText).toMatch(/permanent/i);
  });

  it("the client bundle wires up opening and closing the help overlay", async () => {
    const res = await fetch(new URL("/app.js", baseUrl));
    expect(res.status).toBe(200);
    const js = await res.text();
    expect(js).toContain("help-button");
    expect(js).toContain("help-overlay");
  });
});
