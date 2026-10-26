import { existsSync, rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

// Stage 12: same direct-module-import pattern as spec/simulation.test.ts and
// spec/world.test.ts, against its own throwaway DB file so none of the three
// share state. See CLAUDE.md.
const DB_PATH = "./.data/colony.ecology-test.db";
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(DB_PATH + suffix)) rmSync(DB_PATH + suffix);
}
process.env.DB_PATH = DB_PATH;

const { db, resetForTests, runBootSeedSequenceForTests } = await import("../src/server/db.ts");
const sim = await import("../src/server/simulation.ts");
const ecology = await import("../src/server/ecology.ts");
const {
  colonySpiralPosition,
  QUEEN_MAX_HEALTH,
  STARTING_WORKERS,
  SPAWN_ANCHOR_COUNT,
  ECOLOGY_ANCHOR_ZONE_RADIUS,
  ECOLOGY_BACKGROUND_CELL_SIZE,
  ECOLOGY_ANCHOR_TARGET_DENSITY,
  ECOLOGY_BACKGROUND_TARGET_DENSITY,
  ECOLOGY_REGEN_DEADLINE_MIN_MS,
  ECOLOGY_REGEN_DEADLINE_MAX_MS,
  ECOLOGY_QUEEN_EXCLUSION_RADIUS,
  RUIN_LIFETIME_MS,
  MAX_ECOLOGY_ENTITIES,
  GATHER_YIELD,
  WORKER_MAX_HEALTH,
  REFERENCE_DESIRED_POPULATION,
  REFERENCE_WORLD_AREA,
  RARITY_BASE_WEIGHT,
  ECOLOGY_TYPE_RARITY,
  GLOBAL_SCARCITY_K,
  GLOBAL_SCARCITY_MAX_MULTIPLIER,
} = await import("../src/server/balance.ts");

const world = db.prepare("SELECT id FROM worlds LIMIT 1").get() as { id: number };
const colony = db.prepare("SELECT id FROM colonies LIMIT 1").get() as { id: number };

// seedIfEmpty() always places the default colony's queen at
// colonySpiralPosition(0), which is also anchor:0's center — so anchor:0's
// effective target is permanently reduced by that resident queen's
// exclusion radius. Tests that need a "clean" baseline zone (not already
// affected by exclusion) use whichever anchor index comes back free here
// instead of assuming anchor:0 is empty.
let freeAnchorIndex = -1;
let freeAnchor = { x: 0, y: 0 };

// A tiny deterministic PRNG (not Math.random) for the seeded-RNG scarcity
// test, so trials are reproducible without a new dependency.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

beforeEach(() => {
  resetForTests();
  sim.loadSimulation();
  ecology.resetEcologyState();
  ecology.setEcologyRng(null);

  // An anchor is only a genuinely clean baseline if its effective target is
  // the full, unreduced value — a resident queen's exclusion circle can
  // partially overlap a *neighboring* anchor zone too, so "no colony's own
  // zone is this one" (via zoneForPosition) is not sufficient; checking the
  // actual snapshot target is.
  const snap0 = ecology.getEcologySnapshot(0);
  const freeZone = snap0.anchors.find((a) => a.target === ECOLOGY_ANCHOR_TARGET_DENSITY)!;
  freeAnchorIndex = Number(freeZone.key.split(":")[1]);
  freeAnchor = colonySpiralPosition(freeAnchorIndex);
});

// A point far from every anchor, safely inside world bounds, that still has
// room around it for a second, distinct far-away point (used by the
// zone-classification test).
const ANCHOR0 = colonySpiralPosition(0);
const ANCHOR1 = colonySpiralPosition(1);

// Replicates ecology.ts's private countRawEcologyEntities — a plain read of
// already-public state (db, sim.getCreaturesForWorld), not a reach into
// ecology.ts's internals.
function rawEcologyCount(): number {
  const nodeCount = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM resource_nodes WHERE world_id = ? AND kind = 'source' AND resource_type IN ('sugar','biomass','protein')",
      )
      .get(world.id) as { n: number }
  ).n;
  const creatureCount = sim
    .getCreaturesForWorld(world.id)
    .filter((c) => c.species === "aphid" || c.species === "spider").length;
  return nodeCount + creatureCount;
}

// Same raw count as above, but scoped to a radius around a point — used
// where a test needs to isolate one zone's spawn activity from whatever
// every other simultaneously-eligible zone does in the same tick.
function rawCountNear(x: number, y: number, radius: number): number {
  const nodeRows = db
    .prepare(
      "SELECT x, y FROM resource_nodes WHERE world_id = ? AND kind = 'source' AND resource_type IN ('sugar','biomass','protein')",
    )
    .all(world.id) as { x: number; y: number }[];
  let count = nodeRows.filter((row) => Math.hypot(row.x - x, row.y - y) <= radius).length;
  for (const c of sim.getCreaturesForWorld(world.id)) {
    if ((c.species === "aphid" || c.species === "spider") && Math.hypot(c.x - x, c.y - y) <= radius) count += 1;
  }
  return count;
}

function insertResourceNode(x: number, y: number, resourceType: string, amount: number): number {
  const { lastInsertRowid } = db
    .prepare("INSERT INTO resource_nodes (world_id, x, y, resource_type, amount, max_amount) VALUES (?, ?, ?, ?, ?, ?)")
    .run(world.id, x, y, resourceType, amount, amount);
  return Number(lastInsertRowid);
}

function insertCreature(x: number, y: number, species: string, health: number): number {
  const { lastInsertRowid } = db
    .prepare("INSERT INTO creatures (world_id, x, y, species, health, max_health) VALUES (?, ?, ?, ?, ?, ?)")
    .run(world.id, x, y, species, health, health);
  const id = Number(lastInsertRowid);
  sim.registerCreature({ id, worldId: world.id, species, x, y, health, maxHealth: health });
  return id;
}

// Wipes every sugar/biomass/protein/aphid/spider seeded by resetForTests()
// so a test can measure a zone's density from a known-empty baseline instead
// of whatever buildWorldPopulation() happened to scatter nearby.
function clearAllEcologyEntities(): void {
  db.prepare("DELETE FROM resource_nodes WHERE resource_type IN ('sugar','biomass','protein')").run();
  for (const c of sim.getCreaturesForWorld(world.id)) {
    db.prepare("DELETE FROM creatures WHERE id = ?").run(c.id);
  }
  sim.loadSimulation();
}

function insertColonyRow(opts: {
  x: number;
  y: number;
  status: "active" | "defeated";
  defeatedAt?: string | null;
}): number {
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO colonies (world_id, queen_x, queen_y, status, queen_health, queen_max_health, peak_population, defeated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(world.id, opts.x, opts.y, opts.status, QUEEN_MAX_HEALTH, QUEEN_MAX_HEALTH, STARTING_WORKERS, opts.defeatedAt ?? null);
  const id = Number(lastInsertRowid);
  sim.registerColony(id, opts.x, opts.y, QUEEN_MAX_HEALTH, QUEEN_MAX_HEALTH, STARTING_WORKERS);
  if (opts.status === "defeated") {
    // registerColony always creates an active entry; defeatColony is the only
    // code path that flips status — use the real transition so the in-memory
    // SimColony cache matches what a real defeat produces.
    sim.defeatColony(id, "test");
    if (opts.defeatedAt) {
      db.prepare("UPDATE colonies SET defeated_at = ? WHERE id = ?").run(opts.defeatedAt, id);
    }
  }
  return id;
}

describe("zoneForPosition", () => {
  it("classifies a point inside an anchor's radius as that anchor's zone", () => {
    expect(ecology.zoneForPosition(ANCHOR0.x + 10, ANCHOR0.y)).toBe("anchor:0");
  });

  it("classifies a point far from every anchor as a background cell keyed by its grid coordinates", () => {
    // Pick a point guaranteed far from every anchor: the world centre offset
    // by a large amount is risky (anchor 0 often sits near centre), so
    // instead pick coordinates with no anchor within ECOLOGY_ANCHOR_ZONE_RADIUS.
    const anchors = Array.from({ length: SPAWN_ANCHOR_COUNT }, (_, i) => colonySpiralPosition(i));
    let x = 50;
    let y = 50;
    // Nudge until clear of every anchor (bounded search; world is large).
    outer: for (let cx = 50; cx < 2950; cx += 137) {
      for (let cy = 50; cy < 2950; cy += 149) {
        if (anchors.every((a) => Math.hypot(a.x - cx, a.y - cy) > ECOLOGY_ANCHOR_ZONE_RADIUS + 5)) {
          x = cx;
          y = cy;
          break outer;
        }
      }
    }
    const key = ecology.zoneForPosition(x, y);
    expect(key.startsWith("bg:")).toBe(true);
    const expectedCellX = Math.floor(x / ECOLOGY_BACKGROUND_CELL_SIZE);
    const expectedCellY = Math.floor(y / ECOLOGY_BACKGROUND_CELL_SIZE);
    expect(key).toBe(`bg:${expectedCellX}:${expectedCellY}`);
  });

  it("assigns a point exactly between two anchors to the nearer one", () => {
    const midX = (ANCHOR0.x + ANCHOR1.x) / 2;
    const midY = (ANCHOR0.y + ANCHOR1.y) / 2;
    const distTo0 = Math.hypot(ANCHOR0.x - midX, ANCHOR0.y - midY);
    const distTo1 = Math.hypot(ANCHOR1.x - midX, ANCHOR1.y - midY);
    // Only assert when the midpoint is actually within range of at least one
    // anchor (guaranteed true for Stage 6b's anchor spacing, but guarded
    // rather than assumed).
    if (Math.min(distTo0, distTo1) > ECOLOGY_ANCHOR_ZONE_RADIUS) return;
    const key = ecology.zoneForPosition(midX, midY);
    const expected = distTo0 <= distTo1 ? "anchor:0" : "anchor:1";
    expect(key).toBe(expected);
  });
});

describe("density measurement", () => {
  it("counts weighted density from resource nodes and creatures, and ignores worker/queen positions", () => {
    clearAllEcologyEntities();
    insertResourceNode(ANCHOR0.x, ANCHOR0.y, "sugar", 100);
    insertCreature(ANCHOR0.x + 5, ANCHOR0.y, "aphid", 20);
    // A worker standing right on the anchor must contribute nothing.
    sim.registerWorker({
      id: 999001,
      colonyId: colony.id,
      x: ANCHOR0.x,
      y: ANCHOR0.y,
      health: WORKER_MAX_HEALTH,
      maxHealth: WORKER_MAX_HEALTH,
      caste: "worker",
    });

    const snapshot = ecology.getEcologySnapshot(0);
    const anchor0 = snapshot.anchors.find((a) => a.key === "anchor:0")!;
    // weights: sugar=1, aphid=2 -> density 3
    expect(anchor0.density).toBe(3);
  });
});

describe("depletion deadline + recovery", () => {
  it("starts a pending deadline when a zone is below target, and clears it if it recovers before the deadline", () => {
    clearAllEcologyEntities();
    const key = `anchor:${freeAnchorIndex}`;
    const t0 = 1_000_000;
    ecology.advanceEcology(t0);
    let snap = ecology.getEcologySnapshot(t0);
    const zone = () => snap.anchors.find((a) => a.key === key)!;
    expect(zone().pendingMsRemaining).not.toBeNull();
    expect(zone().pendingMsRemaining!).toBeGreaterThan(0);
    expect(zone().pendingMsRemaining!).toBeLessThanOrEqual(ECOLOGY_REGEN_DEADLINE_MAX_MS);

    // Fill the anchor zone with enough weighted density to clear target
    // before the deadline elapses, then advance again partway through.
    for (let i = 0; i < 20; i++) insertResourceNode(freeAnchor.x, freeAnchor.y, "sugar", 100);
    const t1 = t0 + 5_000;
    ecology.advanceEcology(t1);
    snap = ecology.getEcologySnapshot(t1);
    expect(zone().density).toBeGreaterThanOrEqual(ECOLOGY_ANCHOR_TARGET_DENSITY);
    expect(zone().pendingMsRemaining).toBeNull();
  });

  it("spawns exactly one entity once the deadline elapses while still below target, and resets the deadline", () => {
    clearAllEcologyEntities();
    const key = `anchor:${freeAnchorIndex}`;
    const t0 = 2_000_000;
    ecology.advanceEcology(t0);
    // Scoped to freeAnchor's own radius rather than the whole world: an
    // empty world leaves every zone below target and pending at the same
    // t0, so other zones legitimately spawn in the same tick once their
    // own deadlines elapse too. The "exactly one" invariant is per-zone,
    // not global.
    const before = rawCountNear(freeAnchor.x, freeAnchor.y, ECOLOGY_ANCHOR_ZONE_RADIUS);

    const t1 = t0 + ECOLOGY_REGEN_DEADLINE_MAX_MS + 1;
    ecology.advanceEcology(t1);
    const after = rawCountNear(freeAnchor.x, freeAnchor.y, ECOLOGY_ANCHOR_ZONE_RADIUS);
    expect(after).toBe(before + 1);

    const snap = ecology.getEcologySnapshot(t1);
    const zone = snap.anchors.find((a) => a.key === key)!;
    // Still below target (one spawn is nowhere near target 15), so a fresh
    // deadline must have been set rather than left cleared.
    expect(zone.pendingMsRemaining).not.toBeNull();
    expect(zone.pendingMsRemaining!).toBeGreaterThan(0);
  });
});

describe("scarcity-weighted spawn type selection", () => {
  it("over many trials, spawns the entirely-missing type (protein) far more often than an abundant type (sugar)", () => {
    // pickSpawnType is module-private, so the scarcity bias is verified
    // indirectly: stock sugar/biomass/aphid generously at a clean anchor,
    // leave protein at zero, and tally which type actually gets spawned by
    // advanceEcology() across many independently-seeded trials.
    const spawnedCounts: Record<string, number> = { sugar: 0, biomass: 0, protein: 0, aphid: 0, spider: 0 };

    function countTypesNearFreeAnchor(): Record<string, number> {
      const counts: Record<string, number> = { sugar: 0, biomass: 0, protein: 0, aphid: 0, spider: 0 };
      const nodeRows = db
        .prepare("SELECT resource_type AS t, x, y FROM resource_nodes WHERE world_id = ? AND kind = 'source'")
        .all(world.id) as { t: string; x: number; y: number }[];
      for (const row of nodeRows) {
        if (Math.hypot(row.x - freeAnchor.x, row.y - freeAnchor.y) <= ECOLOGY_ANCHOR_ZONE_RADIUS) counts[row.t] += 1;
      }
      for (const c of sim.getCreaturesForWorld(world.id)) {
        if (
          (c.species === "aphid" || c.species === "spider") &&
          Math.hypot(c.x - freeAnchor.x, c.y - freeAnchor.y) <= ECOLOGY_ANCHOR_ZONE_RADIUS
        ) {
          counts[c.species] += 1;
        }
      }
      return counts;
    }

    // Weighted density must stay BELOW the anchor's target (15) or the zone
    // never goes pending at all: 3 sugar (×1) + 2 biomass (×1.5) + 4 aphid
    // (×2) = 14, matching the anchor's expected sugar:biomass:protein:aphid
    // mix (≈3:2:0.5:4) with protein entirely absent — this leaves exactly
    // one "slot" of room (15 − 14 = 1) for the scarcity bias to fill.
    const trials = 150;
    for (let trial = 0; trial < trials; trial++) {
      clearAllEcologyEntities();
      for (let i = 0; i < 3; i++) insertResourceNode(freeAnchor.x + i, freeAnchor.y, "sugar", 100);
      for (let i = 0; i < 2; i++) insertResourceNode(freeAnchor.x, freeAnchor.y + i, "biomass", 500);
      for (let i = 0; i < 4; i++) insertCreature(freeAnchor.x - i, freeAnchor.y, "aphid", 20);
      ecology.resetEcologyState();
      ecology.setEcologyRng(mulberry32(7_000 + trial));

      const before = countTypesNearFreeAnchor();
      const t0 = 1 + trial * 10_000_000;
      ecology.advanceEcology(t0);
      ecology.advanceEcology(t0 + ECOLOGY_REGEN_DEADLINE_MAX_MS + 1);
      const after = countTypesNearFreeAnchor();
      for (const type of Object.keys(spawnedCounts)) {
        if (after[type] > before[type]) spawnedCounts[type] += 1;
      }
    }
    ecology.setEcologyRng(null);

    expect(spawnedCounts.protein).toBeGreaterThan(spawnedCounts.sugar);
  });
});

describe("global entity cap", () => {
  it("stops spawning once MAX_ECOLOGY_ENTITIES raw entities exist, even with eligible zones", () => {
    clearAllEcologyEntities();
    // Push the raw count to the cap with cheap sugar nodes spread across
    // background cells so they don't themselves satisfy any one zone's
    // target (keeping every zone eligible to want more).
    for (let i = 0; i < MAX_ECOLOGY_ENTITIES; i++) {
      insertResourceNode(100 + i * 5, 100, "sugar", 100);
    }
    const before = rawEcologyCount();
    expect(before).toBeGreaterThanOrEqual(MAX_ECOLOGY_ENTITIES);

    const t0 = 3_000_000;
    ecology.advanceEcology(t0);
    ecology.advanceEcology(t0 + ECOLOGY_REGEN_DEADLINE_MAX_MS + 1);
    const after = rawEcologyCount();
    expect(after).toBe(before);
  });
});

describe("queen / ruin exclusion", () => {
  it("an active queen placed at a clean anchor's center drives that zone's effective target to (near) zero, so nothing can newly pend there", () => {
    clearAllEcologyEntities();
    insertColonyRow({ x: freeAnchor.x, y: freeAnchor.y, status: "active" });

    const t0 = 3_500_000;
    ecology.advanceEcology(t0);
    const snap = ecology.getEcologySnapshot(t0);
    const key = `anchor:${freeAnchorIndex}`;
    const zone = snap.anchors.find((a) => a.key === key)!;
    // The queen sits exactly at the zone's center, so the exclusion circle
    // (radius ECOLOGY_QUEEN_EXCLUSION_RADIUS) fully covers the zone
    // (radius ECOLOGY_ANCHOR_ZONE_RADIUS) whenever exclusion >= zone radius;
    // either way the effective target must drop well below the unexcluded
    // baseline, and with density 0 and target ~0 the zone should not need to
    // pend for regeneration.
    expect(zone.target).toBeLessThan(ECOLOGY_ANCHOR_TARGET_DENSITY);
  });

  it("still excludes/reduces target near a non-expired ruin, and stops once it expires", () => {
    clearAllEcologyEntities();
    const nowMs = 4_000_000;
    const recentlyDefeatedIso = new Date(nowMs - 1000).toISOString();
    const ruinId = insertColonyRow({
      x: freeAnchor.x,
      y: freeAnchor.y,
      status: "defeated",
      defeatedAt: recentlyDefeatedIso,
    });
    const key = `anchor:${freeAnchorIndex}`;

    ecology.advanceEcology(nowMs);
    let snap = ecology.getEcologySnapshot(nowMs);
    let zone = snap.anchors.find((a) => a.key === key)!;
    expect(zone.target).toBeLessThan(ECOLOGY_ANCHOR_TARGET_DENSITY);

    const farPastMs = nowMs - RUIN_LIFETIME_MS - 1000;
    const farPastIso = new Date(farPastMs).toISOString();
    db.prepare("UPDATE colonies SET defeated_at = ? WHERE id = ?").run(farPastIso, ruinId);
    sim.loadSimulation();

    const t1 = nowMs + 1000;
    ecology.advanceEcology(t1);
    snap = ecology.getEcologySnapshot(t1);
    zone = snap.anchors.find((a) => a.key === key)!;
    expect(zone.target).toBe(ECOLOGY_ANCHOR_TARGET_DENSITY);
  });
});

describe("ruin lifetime transitions", () => {
  it("isRuinExpired flips from false to true as nowMs crosses RUIN_LIFETIME_MS past defeatedAt", () => {
    const defeatedAtMs = 5_000_000;
    const defeatedAtIso = new Date(defeatedAtMs).toISOString();
    expect(ecology.isRuinExpired(defeatedAtIso, defeatedAtMs + RUIN_LIFETIME_MS - 1)).toBe(false);
    expect(ecology.isRuinExpired(defeatedAtIso, defeatedAtMs + RUIN_LIFETIME_MS + 1)).toBe(true);
  });

  it("an active colony is never considered expired regardless of nowMs", () => {
    expect(ecology.isRuinExpired(null, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it("getAllColonies (admin) still returns a colony regardless of ruin expiry", () => {
    const farPastIso = new Date(0).toISOString();
    const ruinId = insertColonyRow({ x: ANCHOR1.x, y: ANCHOR1.y, status: "defeated", defeatedAt: farPastIso });
    const all = sim.getAllColonies();
    expect(all.some((c) => c.id === ruinId)).toBe(true);
  });
});

describe("proportional target reduction near an exclusion circle", () => {
  it("lowers a zone's effective target when an active queen's exclusion circle overlaps it", () => {
    const key = `anchor:${freeAnchorIndex}`;
    const baselineSnap = ecology.getEcologySnapshot(0);
    const baselineTarget = baselineSnap.anchors.find((a) => a.key === key)!.target;
    expect(baselineTarget).toBe(ECOLOGY_ANCHOR_TARGET_DENSITY);

    insertColonyRow({ x: freeAnchor.x, y: freeAnchor.y, status: "active" });
    const withQueenSnap = ecology.getEcologySnapshot(0);
    const reducedTarget = withQueenSnap.anchors.find((a) => a.key === key)!.target;
    expect(reducedTarget).toBeLessThan(baselineTarget);
  });
});

describe("resetEcologyState", () => {
  it("clears pending deadlines with no catch-up spawn burst", () => {
    clearAllEcologyEntities();
    const key = `anchor:${freeAnchorIndex}`;
    const t0 = 6_000_000;
    ecology.advanceEcology(t0);
    let snap = ecology.getEcologySnapshot(t0);
    expect(snap.anchors.find((a) => a.key === key)!.pendingMsRemaining).not.toBeNull();

    ecology.resetEcologyState();
    snap = ecology.getEcologySnapshot(t0);
    expect(snap.anchors.find((a) => a.key === key)!.pendingMsRemaining).toBeNull();

    const before = rawEcologyCount();
    // Even calling advanceEcology again right after a reset must not spawn
    // immediately — a fresh deadline has to be started and elapse first.
    ecology.advanceEcology(t0 + 1);
    const after = rawEcologyCount();
    expect(after).toBe(before);
  });
});

// Stage 12 fix: db.ts's legacy seedSpidersIfMissing() used to gate on a live
// `COUNT(*) FROM creatures WHERE species='spider'` check, which can't tell
// "this world never had spiders" apart from "this world legitimately hunted
// its spiders to extinction" — both read as zero. That meant a routine
// server restart after a genuine in-game extinction silently re-inserted
// the full original SPIDER_SEED_POSITIONS list, undoing real gameplay. The
// fix replaces that live count with a durable one-time `creatures_seeded`
// marker column on `worlds`, consumed once by seedCreaturesIfEmpty() and
// never consulted again. These tests prove the invariant the live count
// could never guarantee: an already-initialized world's zero-spider state
// survives any number of repeated boot-sequence runs (what a restart does),
// while a genuinely fresh world still gets its full intended population.
describe("legacy seeder fix: extinction must survive a restart", () => {
  it("an existing world with zero spiders remains at zero after the normal boot/migration sequence runs again (simulated restart)", () => {
    const spiderCountForWorld = db.prepare(
      "SELECT COUNT(*) AS n FROM creatures WHERE world_id = ? AND species = 'spider'",
    );

    // resetForTests() already seeded this world's intended initial
    // population once (via seedCreaturesIfEmpty()) — confirm that baseline,
    // then simulate a real in-game extinction the same way a player/ecology
    // would: deleting the live rows, not touching any seed/migration state.
    expect((spiderCountForWorld.get(world.id) as { n: number }).n).toBeGreaterThan(0);
    db.prepare("DELETE FROM creatures WHERE world_id = ? AND species = 'spider'").run(world.id);
    expect((spiderCountForWorld.get(world.id) as { n: number }).n).toBe(0);

    // A real process restart re-runs the exact same boot-time seed/migration
    // calls (seedIfEmpty, backfillWorldsCreaturesSeeded, seedCreaturesIfEmpty)
    // against the DB file as-is. Run that sequence multiple times — a restart
    // could happen any number of times — and the legitimate extinction must
    // never be undone.
    runBootSeedSequenceForTests();
    expect((spiderCountForWorld.get(world.id) as { n: number }).n).toBe(0);
    runBootSeedSequenceForTests();
    runBootSeedSequenceForTests();
    expect((spiderCountForWorld.get(world.id) as { n: number }).n).toBe(0);

    // Stage 12 ecology, not boot migration, is responsible for recovery —
    // confirmed by the fact that nothing in the boot sequence itself ever
    // spawns a replacement; only advanceEcology() can.
  });

  it("an existing world where every creature (not just spiders) has gone extinct also stays at zero after a simulated restart", () => {
    // Guards the same conflict for every other SPECIES_SEED_POSITIONS
    // entry (aphids today), not just spiders — seedCreaturesIfEmpty()'s own
    // gate is per-world, not per-species, but it's still a live-mutable
    // state question worth proving explicitly: has the world as a whole
    // already been seeded once, independent of its current population.
    db.prepare("DELETE FROM creatures WHERE world_id = ?").run(world.id);
    const totalForWorld = (
      db.prepare("SELECT COUNT(*) AS n FROM creatures WHERE world_id = ?").get(world.id) as { n: number }
    ).n;
    expect(totalForWorld).toBe(0);

    runBootSeedSequenceForTests();
    runBootSeedSequenceForTests();

    const after = (
      db.prepare("SELECT COUNT(*) AS n FROM creatures WHERE world_id = ?").get(world.id) as { n: number }
    ).n;
    expect(after).toBe(0);
  });

  it("a brand-new world (freshly inserted, never seeded) still receives its full intended population on the very next boot pass", () => {
    const { lastInsertRowid } = db.prepare("INSERT INTO worlds (width, height) VALUES (?, ?)").run(3000, 3000);
    const newWorldId = Number(lastInsertRowid);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM creatures WHERE world_id = ?").get(newWorldId) as { n: number }).n,
    ).toBe(0);

    runBootSeedSequenceForTests();

    const spiders = (
      db
        .prepare("SELECT COUNT(*) AS n FROM creatures WHERE world_id = ? AND species = 'spider'")
        .get(newWorldId) as { n: number }
    ).n;
    expect(spiders).toBeGreaterThan(0);

    // Seeded exactly once: running the boot sequence again must not
    // duplicate this world's population.
    const before = (
      db.prepare("SELECT COUNT(*) AS n FROM creatures WHERE world_id = ?").get(newWorldId) as { n: number }
    ).n;
    runBootSeedSequenceForTests();
    const afterSecondPass = (
      db.prepare("SELECT COUNT(*) AS n FROM creatures WHERE world_id = ?").get(newWorldId) as { n: number }
    ).n;
    expect(afterSecondPass).toBe(before);
  });
});

describe("global finite-resource invariant", () => {
  it("every ecology-spawned resource node has a non-null amount and maxAmount", () => {
    clearAllEcologyEntities();
    const t0 = 7_000_000;
    ecology.advanceEcology(t0);
    ecology.advanceEcology(t0 + ECOLOGY_REGEN_DEADLINE_MAX_MS + 1);
    const rows = db
      .prepare("SELECT amount, max_amount AS maxAmount FROM resource_nodes WHERE world_id = ?")
      .all(world.id) as { amount: number | null; maxAmount: number | null }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.amount).not.toBeNull();
      expect(row.maxAmount).not.toBeNull();
    }
  });

  it("a claim can never exceed what's actually left on a node — the infinite-amount branch is gone", () => {
    const node = insertResourceNode(ANCHOR0.x + 500, ANCHOR0.y + 500, "protein", 3);
    const workerId = 999002;
    sim.registerWorker({
      id: workerId,
      colonyId: colony.id,
      x: ANCHOR0.x + 500,
      y: ANCHOR0.y + 500,
      health: WORKER_MAX_HEALTH,
      maxHealth: WORKER_MAX_HEALTH,
      caste: "worker",
    });
    const err = sim.issueGatherCommand(workerId, node, colony.id);
    expect(err).toBeNull();
    for (let i = 0; i < 20; i++) sim.advanceSimulation(1 / 10);
    const worker = sim.getWorkersForColony(colony.id).find((w) => w.id === workerId)!;
    // Claimed amount must be capped at the node's actual remaining amount
    // (3), never the full GATHER_YIELD, proving no infinite-claim path exists.
    expect(worker.carrying?.amount ?? 0).toBeLessThanOrEqual(3);
    expect(worker.carrying?.amount ?? 0).toBeGreaterThan(0);
    expect(worker.carrying!.amount).not.toBe(GATHER_YIELD > 3 ? GATHER_YIELD : worker.carrying!.amount);
  });
});

// Stage 12 addendum: global population scarcity, added after discovering a
// real spider extinction in the shared dev world (ANCHOR_BASE_SHARE.spider
// and BACKGROUND_BASE_SHARE.spider were both 0, so pickSpawnType's old
// `if (share <= 0) continue` guard unconditionally excluded spiders from
// ever being ecology-spawned). See CLAUDE.md for the full rarity x local
// scarcity x global scarcity model.
describe("global population scarcity", () => {
  it("is exactly 1 at or above the desired population (no bonus for abundance)", () => {
    expect(ecology.globalScarcityMultiplier(50, 50)).toBe(1);
    expect(ecology.globalScarcityMultiplier(100, 50)).toBe(1);
  });

  it("applies a modest increase for mild depletion (ratio 0.75 -> ~1.28x)", () => {
    const m = ecology.globalScarcityMultiplier(37.5, 50);
    expect(m).toBeCloseTo(1.284, 2);
    expect(m).toBeGreaterThan(1);
    expect(m).toBeLessThan(1.5);
  });

  it("applies a much larger increase for severe depletion than for mild depletion", () => {
    const mild = ecology.globalScarcityMultiplier(37.5, 50); // ratio 0.75
    const severe = ecology.globalScarcityMultiplier(5, 50); // ratio 0.1
    expect(severe).toBeCloseTo(25.53, 1);
    expect(severe).toBeGreaterThan(mild * 10);
  });

  it("caps pressure at GLOBAL_SCARCITY_MAX_MULTIPLIER when a type is fully extinct (population 0)", () => {
    const m = ecology.globalScarcityMultiplier(0, 50);
    expect(m).toBe(GLOBAL_SCARCITY_MAX_MULTIPLIER);
    expect(m).toBe(50);
  });

  it("scales desired population proportionally with world area, never a hardcoded absolute target", () => {
    const referenceScale = ecology.computeWorldScale(3000, 3000);
    expect(referenceScale).toBe(1);
    const largerScale = ecology.computeWorldScale(6000, 6000); // 4x the reference area
    expect(largerScale).toBe(4);

    const referenceDesired = ecology.desiredPopulationFor("spider", referenceScale);
    expect(referenceDesired).toBe(REFERENCE_DESIRED_POPULATION.spider);
    const largerDesired = ecology.desiredPopulationFor("spider", largerScale);
    expect(largerDesired).toBe(referenceDesired * 4);
  });

  it("an extinct Extremely Rare type's selection score can outweigh a healthy Common type's", () => {
    const spiderScore =
      RARITY_BASE_WEIGHT[ECOLOGY_TYPE_RARITY.spider as keyof typeof RARITY_BASE_WEIGHT] *
      ecology.globalScarcityMultiplier(0, REFERENCE_DESIRED_POPULATION.spider);
    const sugarScore =
      RARITY_BASE_WEIGHT[ECOLOGY_TYPE_RARITY.sugar as keyof typeof RARITY_BASE_WEIGHT] *
      ecology.globalScarcityMultiplier(REFERENCE_DESIRED_POPULATION.sugar, REFERENCE_DESIRED_POPULATION.sugar);
    expect(spiderScore).toBeGreaterThan(sugarScore);
  });

  it("a recovered rare type's multiplier falls back to the neutral 1x baseline once at its desired population", () => {
    const recovered = ecology.globalScarcityMultiplier(REFERENCE_DESIRED_POPULATION.protein, REFERENCE_DESIRED_POPULATION.protein);
    expect(recovered).toBe(1);
  });

  it("computeGlobalPopulation counts every live node/creature of each type, world-wide", () => {
    clearAllEcologyEntities();
    insertResourceNode(ANCHOR0.x, ANCHOR0.y, "sugar", 100);
    insertResourceNode(ANCHOR1.x, ANCHOR1.y, "sugar", 100);
    insertCreature(ANCHOR0.x, ANCHOR0.y, "spider", 20);
    const pop = ecology.computeGlobalPopulation(world.id);
    expect(pop.sugar).toBe(2);
    expect(pop.spider).toBe(1);
    expect(pop.biomass).toBe(0);
  });

  it("a population already above its desired level is never deleted — the multiplier simply returns to baseline", () => {
    clearAllEcologyEntities();
    const oversupply = REFERENCE_DESIRED_POPULATION.sugar * 3;
    for (let i = 0; i < oversupply; i++) insertResourceNode(50 + i * 3, 50, "sugar", 100);
    const before = ecology.computeGlobalPopulation(world.id).sugar;
    expect(before).toBeGreaterThan(REFERENCE_DESIRED_POPULATION.sugar);
    expect(ecology.globalScarcityMultiplier(before, REFERENCE_DESIRED_POPULATION.sugar)).toBe(1);

    const t0 = 10_000_000;
    ecology.advanceEcology(t0);
    ecology.advanceEcology(t0 + ECOLOGY_REGEN_DEADLINE_MAX_MS + 1);
    const after = ecology.computeGlobalPopulation(world.id).sugar;
    expect(after).toBeGreaterThanOrEqual(before);
  });
});

describe("global scarcity integrated into spawn-type selection", () => {
  it("the global entity cap still suppresses all spawns even under extreme global extinction pressure", () => {
    clearAllEcologyEntities();
    // Raw cap reached with sugar nodes; every creature type (aphid, spider)
    // is globally extinct (population 0), which should drive their global
    // scarcity to the maximum — the cap must still win regardless.
    for (let i = 0; i < MAX_ECOLOGY_ENTITIES; i++) {
      insertResourceNode(100 + i * 5, 100, "sugar", 100);
    }
    const before = rawEcologyCount();
    expect(before).toBeGreaterThanOrEqual(MAX_ECOLOGY_ENTITIES);

    const t0 = 11_000_000;
    ecology.advanceEcology(t0);
    ecology.advanceEcology(t0 + ECOLOGY_REGEN_DEADLINE_MAX_MS + 1);
    const after = rawEcologyCount();
    expect(after).toBe(before);
  });

  it("local scarcity still biases selection between two types of equal rarity, even under the new global factor", () => {
    // biomass and aphid are both "uncommon" (equal rarity base weight), so
    // depleting one locally while leaving the other at its expected share
    // isolates the local-scarcity term: both start globally extinct (same
    // global scarcity too, since both populations are 0 after
    // clearAllEcologyEntities), so only the local difference should decide.
    const spawnedCounts: Record<string, number> = { sugar: 0, biomass: 0, protein: 0, aphid: 0, spider: 0 };

    function countTypesNearFreeAnchor(): Record<string, number> {
      const counts: Record<string, number> = { sugar: 0, biomass: 0, protein: 0, aphid: 0, spider: 0 };
      const nodeRows = db
        .prepare("SELECT resource_type AS t, x, y FROM resource_nodes WHERE world_id = ? AND kind = 'source'")
        .all(world.id) as { t: string; x: number; y: number }[];
      for (const row of nodeRows) {
        if (Math.hypot(row.x - freeAnchor.x, row.y - freeAnchor.y) <= ECOLOGY_ANCHOR_ZONE_RADIUS) counts[row.t] += 1;
      }
      for (const c of sim.getCreaturesForWorld(world.id)) {
        if (
          (c.species === "aphid" || c.species === "spider") &&
          Math.hypot(c.x - freeAnchor.x, c.y - freeAnchor.y) <= ECOLOGY_ANCHOR_ZONE_RADIUS
        ) {
          counts[c.species] += 1;
        }
      }
      return counts;
    }

    const trials = 80;
    for (let trial = 0; trial < trials; trial++) {
      clearAllEcologyEntities();
      // Biomass locally depleted (0, expected 2); aphid locally at its
      // expected share (4, expected 4) — the only local difference.
      for (let i = 0; i < 4; i++) insertCreature(freeAnchor.x - i, freeAnchor.y, "aphid", 20);
      ecology.resetEcologyState();
      ecology.setEcologyRng(mulberry32(9_000 + trial));

      const before = countTypesNearFreeAnchor();
      const t0 = 1 + trial * 10_000_000;
      ecology.advanceEcology(t0);
      ecology.advanceEcology(t0 + ECOLOGY_REGEN_DEADLINE_MAX_MS + 1);
      const after = countTypesNearFreeAnchor();
      for (const type of Object.keys(spawnedCounts)) {
        if (after[type] > before[type]) spawnedCounts[type] += 1;
      }
    }
    ecology.setEcologyRng(null);

    expect(spawnedCounts.biomass).toBeGreaterThan(spawnedCounts.aphid);
  });

  it("a fixed RNG override deterministically picks the same spawn type every time (no flakiness)", () => {
    clearAllEcologyEntities();
    ecology.setEcologyRng(() => 0);
    const t0 = 12_000_000;
    ecology.advanceEcology(t0);
    ecology.advanceEcology(t0 + ECOLOGY_REGEN_DEADLINE_MAX_MS + 1);
    // roll = 0 * total = 0, and the loop subtracts the first candidate's
    // weight before checking <= 0 — so it always lands on the first type in
    // iteration order (sugar) whose weight is always > 0 (every type has a
    // nonzero rarity now), deterministically, every run.
    const sugarCount = (
      db
        .prepare("SELECT COUNT(*) AS n FROM resource_nodes WHERE world_id = ? AND resource_type = 'sugar'")
        .get(world.id) as { n: number }
    ).n;
    expect(sugarCount).toBeGreaterThan(0);
    ecology.setEcologyRng(null);
  });
});
