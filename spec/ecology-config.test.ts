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
const { getEcologyConfig, setEcologyConfig, validateEcologyConfigInput, resetEcologyConfigForTests } = await import(
  "../src/server/ecologyConfig.ts"
);
const {
  ECOLOGY_ANCHOR_TARGET_DENSITY,
  ECOLOGY_BACKGROUND_TARGET_DENSITY,
  ECOLOGY_REGEN_DEADLINE_MIN_MS,
  ECOLOGY_REGEN_DEADLINE_MAX_MS,
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

let freeAnchorIndex = -1;

beforeEach(() => {
  resetForTests();
  sim.loadSimulation();
  ecology.resetEcologyState();
  ecology.setEcologyRng(null);

  // Reset the config row directly (not via setEcologyConfig, to stay
  // independent of the function under test) so no prior test's saved
  // values leak into the next one.
  db.prepare(
    "UPDATE ecology_config SET anchor_base_target = ?, background_base_target = ?, regen_delay_min_ms = ?, regen_delay_max_ms = ? WHERE id = 1",
  ).run(ECOLOGY_ANCHOR_TARGET_DENSITY, ECOLOGY_BACKGROUND_TARGET_DENSITY, ECOLOGY_REGEN_DEADLINE_MIN_MS, ECOLOGY_REGEN_DEADLINE_MAX_MS);
  resetEcologyConfigForTests();

  // A resident queen from resetForTests()'s default seed sits on anchor:0's
  // center, reducing its effective target — find whichever anchor is
  // actually unaffected, same technique as spec/ecology.test.ts.
  const snap0 = ecology.getEcologySnapshot(0);
  const freeZone = snap0.anchors.find((a) => a.target === ECOLOGY_ANCHOR_TARGET_DENSITY)!;
  freeAnchorIndex = Number(freeZone.key.split(":")[1]);
});

describe("ecology config defaults", () => {
  it("match balance.ts's Stage 12 constants on a fresh world", () => {
    const config = getEcologyConfig();
    expect(config.anchorBaseTarget).toBe(ECOLOGY_ANCHOR_TARGET_DENSITY);
    expect(config.backgroundBaseTarget).toBe(ECOLOGY_BACKGROUND_TARGET_DENSITY);
    expect(config.regenDelayMinMs).toBe(ECOLOGY_REGEN_DEADLINE_MIN_MS);
    expect(config.regenDelayMaxMs).toBe(ECOLOGY_REGEN_DEADLINE_MAX_MS);
  });
});

describe("setEcologyConfig", () => {
  it("writes all four fields, refreshes the cache, and echoes the saved row back", () => {
    const saved = setEcologyConfig({ anchorBaseTarget: 20, backgroundBaseTarget: 2, regenDelayMinMs: 5000, regenDelayMaxMs: 10000 });
    expect(saved.anchorBaseTarget).toBe(20);
    expect(saved.backgroundBaseTarget).toBe(2);
    expect(saved.regenDelayMinMs).toBe(5000);
    expect(saved.regenDelayMaxMs).toBe(10000);
    expect(getEcologyConfig()).toEqual(saved);
  });

  it("persists to SQLite so a freshly reopened connection (simulating a server restart) sees the same values", () => {
    setEcologyConfig({ anchorBaseTarget: 22, backgroundBaseTarget: 3, regenDelayMinMs: 6000, regenDelayMaxMs: 9000 });
    const reopened = new Database(DB_PATH);
    try {
      const row = reopened
        .prepare(
          "SELECT anchor_base_target AS a, background_base_target AS b, regen_delay_min_ms AS min, regen_delay_max_ms AS max FROM ecology_config WHERE id = 1",
        )
        .get() as { a: number; b: number; min: number; max: number };
      expect(row.a).toBe(22);
      expect(row.b).toBe(3);
      expect(row.min).toBe(6000);
      expect(row.max).toBe(9000);
    } finally {
      reopened.close();
    }
  });

  it("resetEcologyConfigForTests() clears the in-memory cache so the next read reflects whatever is actually in SQLite", () => {
    setEcologyConfig({ anchorBaseTarget: 25, backgroundBaseTarget: 4, regenDelayMinMs: 7000, regenDelayMaxMs: 11000 });
    // Mutate the row directly, bypassing setEcologyConfig, proving the cache
    // isn't just remembering the JS object it was handed.
    db.prepare("UPDATE ecology_config SET anchor_base_target = ? WHERE id = 1").run(99);
    expect(getEcologyConfig().anchorBaseTarget).toBe(25);
    resetEcologyConfigForTests();
    expect(getEcologyConfig().anchorBaseTarget).toBe(99);
  });

  it("never touches existing resource nodes, creatures, or colonies — saving tunes future ticks only", () => {
    const countsOf = () => ({
      nodes: (db.prepare("SELECT COUNT(*) AS n FROM resource_nodes").get() as { n: number }).n,
      creatures: (db.prepare("SELECT COUNT(*) AS n FROM creatures").get() as { n: number }).n,
      colonies: (db.prepare("SELECT COUNT(*) AS n FROM colonies").get() as { n: number }).n,
    });
    const before = countsOf();
    setEcologyConfig({ anchorBaseTarget: 33, backgroundBaseTarget: 5, regenDelayMinMs: 4000, regenDelayMaxMs: 9000 });
    expect(countsOf()).toEqual(before);
  });
});

describe("validateEcologyConfigInput", () => {
  it("accepts a fully valid input", () => {
    expect(validateEcologyConfigInput({ anchorBaseTarget: 10, backgroundBaseTarget: 1, regenDelayMinMs: 2000, regenDelayMaxMs: 3000 })).toBeNull();
  });

  it("rejects a non-finite or missing field", () => {
    expect(
      validateEcologyConfigInput({ anchorBaseTarget: Number.NaN, backgroundBaseTarget: 1, regenDelayMinMs: 2000, regenDelayMaxMs: 3000 }),
    ).toMatch(/anchorBaseTarget/);
    expect(validateEcologyConfigInput({ backgroundBaseTarget: 1, regenDelayMinMs: 2000, regenDelayMaxMs: 3000 })).toMatch(/anchorBaseTarget/);
    expect(
      validateEcologyConfigInput({ anchorBaseTarget: 10, backgroundBaseTarget: 1, regenDelayMinMs: 2000, regenDelayMaxMs: Number.POSITIVE_INFINITY }),
    ).toMatch(/regenDelayMaxMs/);
  });

  it("rejects a zero or negative anchor/background target", () => {
    expect(validateEcologyConfigInput({ anchorBaseTarget: 0, backgroundBaseTarget: 1, regenDelayMinMs: 2000, regenDelayMaxMs: 3000 })).toMatch(
      /anchorBaseTarget/,
    );
    expect(validateEcologyConfigInput({ anchorBaseTarget: 10, backgroundBaseTarget: -1, regenDelayMinMs: 2000, regenDelayMaxMs: 3000 })).toMatch(
      /backgroundBaseTarget/,
    );
  });

  it("rejects a regen delay below the 1000ms floor", () => {
    expect(validateEcologyConfigInput({ anchorBaseTarget: 10, backgroundBaseTarget: 1, regenDelayMinMs: 999, regenDelayMaxMs: 3000 })).toMatch(
      /regenDelayMinMs/,
    );
    expect(validateEcologyConfigInput({ anchorBaseTarget: 10, backgroundBaseTarget: 1, regenDelayMinMs: 1000, regenDelayMaxMs: 999 })).toMatch(
      /regenDelayMaxMs/,
    );
  });

  it("rejects regenDelayMinMs greater than regenDelayMaxMs, but accepts the min === max boundary", () => {
    expect(validateEcologyConfigInput({ anchorBaseTarget: 10, backgroundBaseTarget: 1, regenDelayMinMs: 5000, regenDelayMaxMs: 4000 })).toMatch(
      /regenDelayMinMs/,
    );
    expect(
      validateEcologyConfigInput({ anchorBaseTarget: 10, backgroundBaseTarget: 1, regenDelayMinMs: 4000, regenDelayMaxMs: 4000 }),
    ).toBeNull();
  });
});

describe("config changes affect future ecology ticks only", () => {
  it("a saved anchorBaseTarget/backgroundBaseTarget is reflected in the very next snapshot's baseTarget", () => {
    setEcologyConfig({ anchorBaseTarget: 42, backgroundBaseTarget: 7, regenDelayMinMs: 15000, regenDelayMaxMs: 60000 });
    const snap = ecology.getEcologySnapshot(0);
    for (const anchor of snap.anchors) {
      expect(anchor.baseTarget).toBe(42);
    }
  });

  it("a saved min/max regen delay exactly bounds the next pending deadline (rng=0 -> min, rng=1 -> max)", () => {
    setEcologyConfig({
      anchorBaseTarget: ECOLOGY_ANCHOR_TARGET_DENSITY,
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
