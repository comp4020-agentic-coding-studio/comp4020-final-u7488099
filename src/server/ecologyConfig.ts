// Stage 12.5B: durable, admin-editable ecology tuning knobs. Deliberately
// narrow in scope — only the values the spec calls out (per-anchor base
// density targets, background base density target, min/max regen delay).
// Everything else ecology-related (MAX_ECOLOGY_ENTITIES, rarity
// coefficients, global scarcity K/G_MAX, desired populations, entity
// weights, spawn retry limits) stays a code-only constant in balance.ts by
// design.
//
// Stage 12.5B follow-up: the single global anchorBaseTarget was replaced by
// SPAWN_ANCHOR_COUNT independent per-anchor targets (ecology_anchor_config,
// one row per anchor index — see db.ts's seedEcologyAnchorConfig for the
// production-safe migration that seeds every anchor from the old global
// value). ecology_config.anchor_base_target is no longer read by anchor
// ecology at all; it's left in the row purely so the column doesn't need a
// DROP. anchorBaseTargets below is always a length-SPAWN_ANCHOR_COUNT array
// indexed by anchor index.
import { db } from "./db.ts";
import {
  ECOLOGY_ANCHOR_TARGET_DENSITY,
  ECOLOGY_BACKGROUND_TARGET_DENSITY,
  ECOLOGY_REGEN_DEADLINE_MAX_MS,
  ECOLOGY_REGEN_DEADLINE_MIN_MS,
  SPAWN_ANCHOR_COUNT,
} from "./balance.ts";

export interface EcologyConfig {
  anchorBaseTargets: number[];
  backgroundBaseTarget: number;
  regenDelayMinMs: number;
  regenDelayMaxMs: number;
  updatedAt: string;
}

interface EcologyConfigRow {
  background_base_target: number;
  regen_delay_min_ms: number;
  regen_delay_max_ms: number;
  updated_at: string;
}

const selectStmt = db.prepare(
  "SELECT background_base_target, regen_delay_min_ms, regen_delay_max_ms, updated_at FROM ecology_config WHERE id = 1",
);

const selectAnchorsStmt = db.prepare(
  "SELECT anchor_index AS anchorIndex, base_target AS baseTarget FROM ecology_anchor_config ORDER BY anchor_index",
);

function loadAnchorTargets(): number[] {
  const rows = selectAnchorsStmt.all() as { anchorIndex: number; baseTarget: number }[];
  const targets = new Array<number>(SPAWN_ANCHOR_COUNT).fill(ECOLOGY_ANCHOR_TARGET_DENSITY);
  for (const row of rows) {
    if (row.anchorIndex >= 0 && row.anchorIndex < SPAWN_ANCHOR_COUNT) targets[row.anchorIndex] = row.baseTarget;
  }
  return targets;
}

// Cached in-memory so every ecology tick / snapshot call doesn't need its
// own SQLite round trip (advanceEcology runs every 5s, getEcologySnapshot
// can be polled every ~1.5s from the admin map — neither should pay a
// query for a handful of numbers that only change when an admin explicitly
// saves).
let cached: EcologyConfig | null = null;

function loadFromDb(): EcologyConfig {
  const row = selectStmt.get() as EcologyConfigRow | undefined;
  const anchorBaseTargets = loadAnchorTargets();
  if (!row) {
    // The CREATE TABLE + INSERT OR IGNORE in db.ts always seeds row id=1 at
    // boot, so this only happens inside a test that reset the DB without
    // reseeding — fall back to the documented Stage 12 defaults rather than
    // throwing.
    return {
      anchorBaseTargets,
      backgroundBaseTarget: ECOLOGY_BACKGROUND_TARGET_DENSITY,
      regenDelayMinMs: ECOLOGY_REGEN_DEADLINE_MIN_MS,
      regenDelayMaxMs: ECOLOGY_REGEN_DEADLINE_MAX_MS,
      updatedAt: new Date(0).toISOString(),
    };
  }
  return {
    anchorBaseTargets,
    backgroundBaseTarget: row.background_base_target,
    regenDelayMinMs: row.regen_delay_min_ms,
    regenDelayMaxMs: row.regen_delay_max_ms,
    updatedAt: row.updated_at,
  };
}

export function getEcologyConfig(): EcologyConfig {
  if (!cached) cached = loadFromDb();
  return cached;
}

// Convenience accessor for ecology.ts's zoneDefinition() — avoids every call
// site re-destructuring the array out of the full config object.
export function getAnchorBaseTarget(index: number): number {
  return getEcologyConfig().anchorBaseTargets[index] ?? ECOLOGY_ANCHOR_TARGET_DENSITY;
}

export interface EcologyConfigInput {
  anchorBaseTargets: number[];
  backgroundBaseTarget: number;
  regenDelayMinMs: number;
  regenDelayMaxMs: number;
}

const MIN_REGEN_DELAY_FLOOR_MS = 1000;

// Returns a validation error message, or null if the input is valid. All
// SPAWN_ANCHOR_COUNT anchor values plus the three remaining scalars are
// checked together so the caller can reject the whole PUT atomically — no
// partial write on a single bad anchor value.
export function validateEcologyConfigInput(input: Partial<Record<keyof EcologyConfigInput, unknown>>): string | null {
  const { anchorBaseTargets, backgroundBaseTarget, regenDelayMinMs, regenDelayMaxMs } = input;
  if (!Array.isArray(anchorBaseTargets) || anchorBaseTargets.length !== SPAWN_ANCHOR_COUNT) {
    return `anchorBaseTargets must be an array of ${SPAWN_ANCHOR_COUNT} numbers`;
  }
  for (let i = 0; i < anchorBaseTargets.length; i++) {
    const value = anchorBaseTargets[i];
    if (typeof value !== "number" || !Number.isFinite(value)) return `anchorBaseTargets[${i}] must be a finite number`;
    if (value <= 0) return `anchorBaseTargets[${i}] must be greater than 0`;
  }
  for (const [name, value] of Object.entries({ backgroundBaseTarget, regenDelayMinMs, regenDelayMaxMs })) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return `${name} must be a finite number`;
    }
  }
  const b = backgroundBaseTarget as number;
  const min = regenDelayMinMs as number;
  const max = regenDelayMaxMs as number;
  if (b <= 0) return "backgroundBaseTarget must be greater than 0";
  if (min < MIN_REGEN_DELAY_FLOOR_MS) return `regenDelayMinMs must be at least ${MIN_REGEN_DELAY_FLOOR_MS}`;
  if (max < MIN_REGEN_DELAY_FLOOR_MS) return `regenDelayMaxMs must be at least ${MIN_REGEN_DELAY_FLOOR_MS}`;
  if (min > max) return "regenDelayMinMs must be less than or equal to regenDelayMaxMs";
  return null;
}

const updateStmt = db.prepare(
  "UPDATE ecology_config SET background_base_target = ?, regen_delay_min_ms = ?, regen_delay_max_ms = ?, updated_at = datetime('now') WHERE id = 1",
);

const upsertAnchorStmt = db.prepare(
  "INSERT INTO ecology_anchor_config (anchor_index, base_target, updated_at) VALUES (?, ?, datetime('now')) " +
    "ON CONFLICT(anchor_index) DO UPDATE SET base_target = excluded.base_target, updated_at = excluded.updated_at",
);

// Caller is responsible for validating first (validateEcologyConfigInput) —
// this never partially writes (the whole write runs in one transaction, so
// either every anchor row plus the scalar row update succeeds, or none of
// it does), and always refreshes the cache + returns the server-
// authoritative saved row so the caller can echo it back verbatim.
const setEcologyConfigTxn = db.transaction((input: EcologyConfigInput) => {
  updateStmt.run(input.backgroundBaseTarget, input.regenDelayMinMs, input.regenDelayMaxMs);
  for (let i = 0; i < input.anchorBaseTargets.length; i++) {
    upsertAnchorStmt.run(i, input.anchorBaseTargets[i]);
  }
});

export function setEcologyConfig(input: EcologyConfigInput): EcologyConfig {
  setEcologyConfigTxn(input);
  cached = loadFromDb();
  return cached;
}

export function resetEcologyConfigForTests(): void {
  cached = null;
}
