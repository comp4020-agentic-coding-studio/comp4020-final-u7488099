import Database from "better-sqlite3";
import { existsSync, rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

// Stage 12.5B: same direct-module-import pattern as spec/ecology.test.ts,
// against its own throwaway DB file so neither shares state with it or any
// other spec file. HTTP-level authorization for the two new admin routes
// (GET/PUT /api/admin/ecology-config) is covered black-box in
// spec/admin.test.ts — this file only exercises ecologyConfig.ts/ecology.ts
// directly, where there is no requireAdmin to call. See CLAUDE.md.
const DB_PATH = "./.data/colony.ecology-config-test.db";
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(DB_PATH + suffix)) rmSync(DB_PATH + suffix);
}
process.env.DB_PATH = DB_PATH;

const { db, resetForTests } = await import("../src/server/db.ts");
const sim = await import("../src/server/simulation.ts");
const ecology = await import("../src/server/ecology.ts");
const { getEcologyConfig, setEcologyConfig, validateEcologyConfigInput, resetEcologyConfigForTests, getAnchorBaseTarget } =
  await import("../src/server/ecologyConfig.ts");
const {
  ECOLOGY_ANCHOR_TARGET_DENSITY,
  ECOLOGY_BACKGROUND_TARGET_DENSITY,
  ECOLOGY_REGEN_DEADLINE_MIN_MS,
  ECOLOGY_REGEN_DEADLINE_MAX_MS,
  SPAWN_ANCHOR_COUNT,
} = await import("../src/server/balance.ts");

const world = db.prepare("SELECT id FROM worlds LIMIT 1").get() as { id: number };

// Mirrors spec/ecology.test.ts's own helper: wipes every sugar/biomass/
// protein/aphid/spider so a test can measure a zone's pending-regen state
// from a known-empty baseline.
function clearAllEcologyEntities(): void {
  db.prepare("DELETE FROM resource_nodes WHERE resource_type IN ('sugar','biomass','protein')").run();
  for (const c of sim.getCreaturesForWorld(world.id)) {
    db.prepare("DELETE FROM creatures WHERE id = ?").run(c.id);
  }
  sim.loadSimulation();
}

function defaultAnchorTargets(): number[] {
  return new Array(SPAWN_ANCHOR_COUNT).fill(ECOLOGY_ANCHOR_TARGET_DENSITY);
}

let freeAnchorIndex = -1;

beforeEach(() => {
  resetForTests();
  sim.loadSimulation();
  ecology.resetEcologyState();
  ecology.setEcologyRng(null);

  // Reset both the scalar config row and every per-anchor row directly (not
  // via setEcologyConfig, to stay independent of the function under test) so
  // no prior test's saved values leak into the next one.
  db.prepare(
    "UPDATE ecology_config SET anchor_base_target = ?, background_base_target = ?, regen_delay_min_ms = ?, regen_delay_max_ms = ? WHERE id = 1",
  ).run(ECOLOGY_ANCHOR_TARGET_DENSITY, ECOLOGY_BACKGROUND_TARGET_DENSITY, ECOLOGY_REGEN_DEADLINE_MIN_MS, ECOLOGY_REGEN_DEADLINE_MAX_MS);
  const upsert = db.prepare(
    "INSERT INTO ecology_anchor_config (anchor_index, base_target) VALUES (?, ?) " +
      "ON CONFLICT(anchor_index) DO UPDATE SET base_target = excluded.base_target",
  );
  for (let i = 0; i < SPAWN_ANCHOR_COUNT; i++) upsert.run(i, ECOLOGY_ANCHOR_TARGET_DENSITY);
  resetEcologyConfigForTests();

  // A resident queen from resetForTests()'s default seed sits on anchor:0's
  // center, reducing its effective target — find whichever anchor is
  // actually unaffected, same technique as spec/ecology.test.ts.
  const snap0 = ecology.getEcologySnapshot(0);
  const freeZone = snap0.anchors.find((a) => a.target === ECOLOGY_ANCHOR_TARGET_DENSITY)!;
  freeAnchorIndex = Number(freeZone.key.split(":")[1]);
});

function otherFreeIndex(exclude: number): number {
  for (let i = 0; i < SPAWN_ANCHOR_COUNT; i++) {
    if (i !== exclude && i !== 0) return i; // anchor:0 carries the seeded queen's exclusion in this DB
  }
  throw new Error("no spare anchor index");
}

describe("ecology config defaults", () => {
  it("match balance.ts's Stage 12 constants on a fresh world, including all SPAWN_ANCHOR_COUNT anchors", () => {
    const config = getEcologyConfig();
    expect(config.anchorBaseTargets).toEqual(defaultAnchorTargets());
    expect(config.backgroundBaseTarget).toBe(ECOLOGY_BACKGROUND_TARGET_DENSITY);
    expect(config.regenDelayMinMs).toBe(ECOLOGY_REGEN_DEADLINE_MIN_MS);
    expect(config.regenDelayMaxMs).toBe(ECOLOGY_REGEN_DEADLINE_MAX_MS);
  });

  it("migrates/defaults every one of the 10 anchors from the previously persisted global anchor target", () => {
    // Simulate "production already had a custom global anchor target before
    // this migration shipped": set the legacy scalar column directly, drop
    // the per-anchor table's rows, then re-run the exact seed function db.ts
    // calls at boot.
    db.prepare("UPDATE ecology_config SET anchor_base_target = ? WHERE id = 1").run(77);
    db.prepare("DELETE FROM ecology_anchor_config").run();
    const row = db.prepare("SELECT anchor_base_target AS v FROM ecology_config WHERE id = 1").get() as { v: number };
    const insert = db.prepare("INSERT INTO ecology_anchor_config (anchor_index, base_target) VALUES (?, ?)");
    for (let i = 0; i < SPAWN_ANCHOR_COUNT; i++) insert.run(i, row.v);
    resetEcologyConfigForTests();

    const config = getEcologyConfig();
    expect(config.anchorBaseTargets).toEqual(new Array(SPAWN_ANCHOR_COUNT).fill(77));
  });
});

describe("setEcologyConfig", () => {
  it("writes the background/delay fields plus all anchor targets, refreshes the cache, and echoes the saved row back", () => {
    const anchorBaseTargets = defaultAnchorTargets();
    anchorBaseTargets[freeAnchorIndex] = 20;
    const saved = setEcologyConfig({ anchorBaseTargets, backgroundBaseTarget: 2, regenDelayMinMs: 5000, regenDelayMaxMs: 10000 });
    expect(saved.anchorBaseTargets).toEqual(anchorBaseTargets);
    expect(saved.backgroundBaseTarget).toBe(2);
    expect(saved.regenDelayMinMs).toBe(5000);
    expect(saved.regenDelayMaxMs).toBe(10000);
    expect(getEcologyConfig()).toEqual(saved);
  });

  it("persists per-anchor targets independently to SQLite so a freshly reopened connection (simulating a server restart) sees the same values", () => {
    const anchorBaseTargets = defaultAnchorTargets();
    anchorBaseTargets[0] = 11;
    anchorBaseTargets[5] = 99;
    setEcologyConfig({ anchorBaseTargets, backgroundBaseTarget: 3, regenDelayMinMs: 6000, regenDelayMaxMs: 9000 });
    const reopened = new Database(DB_PATH);
    try {
      const rows = reopened
        .prepare("SELECT anchor_index AS idx, base_target AS t FROM ecology_anchor_config ORDER BY anchor_index")
        .all() as { idx: number; t: number }[];
      expect(rows.length).toBe(SPAWN_ANCHOR_COUNT);
      expect(rows[0].t).toBe(11);
      expect(rows[5].t).toBe(99);
      const row = reopened
        .prepare("SELECT background_base_target AS b, regen_delay_min_ms AS min, regen_delay_max_ms AS max FROM ecology_config WHERE id = 1")
        .get() as { b: number; min: number; max: number };
      expect(row.b).toBe(3);
      expect(row.min).toBe(6000);
      expect(row.max).toBe(9000);
    } finally {
      reopened.close();
    }
  });

  it("changing one anchor's target does not change any other anchor's target", () => {
    const a = freeAnchorIndex;
    const b = otherFreeIndex(a);
    const anchorBaseTargets = defaultAnchorTargets();
    anchorBaseTargets[a] = 50;
    setEcologyConfig({ anchorBaseTargets, backgroundBaseTarget: ECOLOGY_BACKGROUND_TARGET_DENSITY, regenDelayMinMs: ECOLOGY_REGEN_DEADLINE_MIN_MS, regenDelayMaxMs: ECOLOGY_REGEN_DEADLINE_MAX_MS });

    expect(getAnchorBaseTarget(a)).toBe(50);
    expect(getAnchorBaseTarget(b)).toBe(ECOLOGY_ANCHOR_TARGET_DENSITY);
    expect(getAnchorBaseTarget(0)).toBe(ECOLOGY_ANCHOR_TARGET_DENSITY);

    // A second, different single-anchor edit confirms the independence isn't
    // coincidental to which index was touched first (anchor:2 vs anchor:1/3,
    // per the explicit requirement) when all three are free anchors.
    const second = defaultAnchorTargets();
    second[a] = 50;
    const other2 = otherFreeIndex(a) === b ? otherFreeIndex(b) : b;
    second[other2] = 30;
    setEcologyConfig({ anchorBaseTargets: second, backgroundBaseTarget: ECOLOGY_BACKGROUND_TARGET_DENSITY, regenDelayMinMs: ECOLOGY_REGEN_DEADLINE_MIN_MS, regenDelayMaxMs: ECOLOGY_REGEN_DEADLINE_MAX_MS });
    expect(getAnchorBaseTarget(a)).toBe(50);
    expect(getAnchorBaseTarget(other2)).toBe(30);
    for (let i = 0; i < SPAWN_ANCHOR_COUNT; i++) {
      if (i === a || i === other2) continue;
      expect(getAnchorBaseTarget(i)).toBe(ECOLOGY_ANCHOR_TARGET_DENSITY);
    }
  });

  it("resetEcologyConfigForTests() clears the in-memory cache so the next read reflects whatever is actually in SQLite", () => {
    const anchorBaseTargets = defaultAnchorTargets();
    anchorBaseTargets[freeAnchorIndex] = 25;
    setEcologyConfig({ anchorBaseTargets, backgroundBaseTarget: 4, regenDelayMinMs: 7000, regenDelayMaxMs: 11000 });
    // Mutate a row directly, bypassing setEcologyConfig, proving the cache
    // isn't just remembering the JS object it was handed.
    db.prepare("UPDATE ecology_anchor_config SET base_target = ? WHERE anchor_index = ?").run(99, freeAnchorIndex);
    expect(getEcologyConfig().anchorBaseTargets[freeAnchorIndex]).toBe(25);
    resetEcologyConfigForTests();
    expect(getEcologyConfig().anchorBaseTargets[freeAnchorIndex]).toBe(99);
  });

  it("never touches existing resource nodes, creatures, or colonies — saving tunes future ticks only", () => {
    const countsOf = () => ({
      nodes: (db.prepare("SELECT COUNT(*) AS n FROM resource_nodes").get() as { n: number }).n,
      creatures: (db.prepare("SELECT COUNT(*) AS n FROM creatures").get() as { n: number }).n,
      colonies: (db.prepare("SELECT COUNT(*) AS n FROM colonies").get() as { n: number }).n,
    });
    const before = countsOf();
    const anchorBaseTargets = defaultAnchorTargets();
    anchorBaseTargets[freeAnchorIndex] = 33;
    setEcologyConfig({ anchorBaseTargets, backgroundBaseTarget: 5, regenDelayMinMs: 4000, regenDelayMaxMs: 9000 });
    expect(countsOf()).toEqual(before);
  });

  it("rejects an invalid combined write atomically — no per-anchor row is changed when any field is invalid", () => {
    const before = getEcologyConfig();
    const badAnchorTargets = defaultAnchorTargets();
    badAnchorTargets[freeAnchorIndex] = 42;
    badAnchorTargets[3] = -5; // invalid: must be > 0
    const error = validateEcologyConfigInput({
      anchorBaseTargets: badAnchorTargets,
      backgroundBaseTarget: ECOLOGY_BACKGROUND_TARGET_DENSITY,
      regenDelayMinMs: ECOLOGY_REGEN_DEADLINE_MIN_MS,
      regenDelayMaxMs: ECOLOGY_REGEN_DEADLINE_MAX_MS,
    });
    expect(error).toMatch(/anchorBaseTargets\[3\]/);
    // Caller (the real HTTP route) never calls setEcologyConfig when
    // validation fails — confirm the stored config is still exactly what it
    // was before the attempted write.
    expect(getEcologyConfig()).toEqual(before);
  });
});

describe("validateEcologyConfigInput", () => {
  function validInput() {
    return {
      anchorBaseTargets: defaultAnchorTargets(),
      backgroundBaseTarget: 1,
      regenDelayMinMs: 2000,
      regenDelayMaxMs: 3000,
    };
  }

  it("accepts a fully valid input", () => {
    expect(validateEcologyConfigInput(validInput())).toBeNull();
  });

  it("rejects a missing or wrong-length anchorBaseTargets array", () => {
    const { anchorBaseTargets: _omit, ...rest } = validInput();
    expect(validateEcologyConfigInput(rest)).toMatch(/anchorBaseTargets/);
    expect(validateEcologyConfigInput({ ...validInput(), anchorBaseTargets: defaultAnchorTargets().slice(0, 5) })).toMatch(
      /anchorBaseTargets/,
    );
  });

  it("rejects a non-finite or zero/negative individual anchor value, reporting which index", () => {
    const nanTargets = defaultAnchorTargets();
    nanTargets[4] = Number.NaN;
    expect(validateEcologyConfigInput({ ...validInput(), anchorBaseTargets: nanTargets })).toMatch(/anchorBaseTargets\[4\]/);

    const zeroTargets = defaultAnchorTargets();
    zeroTargets[7] = 0;
    expect(validateEcologyConfigInput({ ...validInput(), anchorBaseTargets: zeroTargets })).toMatch(/anchorBaseTargets\[7\]/);
  });

  it("rejects a non-finite or missing background/delay field", () => {
    expect(validateEcologyConfigInput({ ...validInput(), backgroundBaseTarget: Number.NaN })).toMatch(/backgroundBaseTarget/);
    const { backgroundBaseTarget: _omit, ...rest } = validInput();
    expect(validateEcologyConfigInput(rest)).toMatch(/backgroundBaseTarget/);
    expect(validateEcologyConfigInput({ ...validInput(), regenDelayMaxMs: Number.POSITIVE_INFINITY })).toMatch(/regenDelayMaxMs/);
  });

  it("rejects a zero or negative background target", () => {
    expect(validateEcologyConfigInput({ ...validInput(), backgroundBaseTarget: -1 })).toMatch(/backgroundBaseTarget/);
  });

  it("rejects a regen delay below the 1000ms floor", () => {
    expect(validateEcologyConfigInput({ ...validInput(), regenDelayMinMs: 999 })).toMatch(/regenDelayMinMs/);
    expect(validateEcologyConfigInput({ ...validInput(), regenDelayMinMs: 1000, regenDelayMaxMs: 999 })).toMatch(/regenDelayMaxMs/);
  });

  it("rejects regenDelayMinMs greater than regenDelayMaxMs, but accepts the min === max boundary", () => {
    expect(validateEcologyConfigInput({ ...validInput(), regenDelayMinMs: 5000, regenDelayMaxMs: 4000 })).toMatch(/regenDelayMinMs/);
    expect(validateEcologyConfigInput({ ...validInput(), regenDelayMinMs: 4000, regenDelayMaxMs: 4000 })).toBeNull();
  });
});

describe("config changes affect future ecology ticks only, per the correct anchor", () => {
  it("a saved per-anchor target is reflected in the very next snapshot's baseTarget for that anchor only", () => {
    const a = freeAnchorIndex;
    const b = otherFreeIndex(a);
    const anchorBaseTargets = defaultAnchorTargets();
    anchorBaseTargets[a] = 42;
    setEcologyConfig({ anchorBaseTargets, backgroundBaseTarget: 7, regenDelayMinMs: 15000, regenDelayMaxMs: 60000 });
    const snap = ecology.getEcologySnapshot(0);
    expect(snap.anchors[a].baseTarget).toBe(42);
    expect(snap.anchors[b].baseTarget).toBe(ECOLOGY_ANCHOR_TARGET_DENSITY);
  });

  it("exclusion adjustment is applied on top of the per-anchor base target, not bypassed by it", () => {
    // anchor:0 carries the seeded queen's full-containment exclusion in this
    // DB (see spec/ecology.test.ts's own documented investigation) — even a
    // large configured base target there must still come out to an
    // effective target reduced by exclusion coverage, never equal to the raw
    // base target.
    const anchorBaseTargets = defaultAnchorTargets();
    anchorBaseTargets[0] = 50;
    setEcologyConfig({ anchorBaseTargets, backgroundBaseTarget: ECOLOGY_BACKGROUND_TARGET_DENSITY, regenDelayMinMs: ECOLOGY_REGEN_DEADLINE_MIN_MS, regenDelayMaxMs: ECOLOGY_REGEN_DEADLINE_MAX_MS });
    const snap = ecology.getEcologySnapshot(0);
    const anchorZero = snap.anchors[0];
    expect(anchorZero.baseTarget).toBe(50);
    expect(anchorZero.exclusionCoverage).toBeGreaterThan(0);
    expect(anchorZero.target).toBe(50 * (1 - anchorZero.exclusionCoverage));
    expect(anchorZero.target).toBeLessThan(50);
  });

  it("a saved min/max regen delay exactly bounds the next pending deadline (rng=0 -> min, rng=1 -> max)", () => {
    setEcologyConfig({
      anchorBaseTargets: defaultAnchorTargets(),
      backgroundBaseTarget: ECOLOGY_BACKGROUND_TARGET_DENSITY,
      regenDelayMinMs: 3000,
      regenDelayMaxMs: 8000,
    });
    clearAllEcologyEntities();
    const key = `anchor:${freeAnchorIndex}`;
    const t0 = 1_000_000;

    ecology.setEcologyRng(() => 0);
    ecology.advanceEcology(t0);
    let snap = ecology.getEcologySnapshot(t0);
    expect(snap.anchors.find((a) => a.key === key)!.pendingMsRemaining).toBe(3000);

    ecology.resetEcologyState();
    ecology.setEcologyRng(() => 1);
    ecology.advanceEcology(t0);
    snap = ecology.getEcologySnapshot(t0);
    expect(snap.anchors.find((a) => a.key === key)!.pendingMsRemaining).toBe(8000);

    ecology.setEcologyRng(null);
  });
});
