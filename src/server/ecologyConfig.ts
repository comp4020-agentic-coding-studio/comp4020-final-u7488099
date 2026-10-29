// Stage 12.5B: durable, admin-editable ecology tuning knobs. Deliberately
// narrow in scope — only the four values the spec calls out (anchor/
// background base density targets, min/max regen delay). Everything else
// ecology-related (MAX_ECOLOGY_ENTITIES, rarity coefficients, global
// scarcity K/G_MAX, desired populations, entity weights, spawn retry
// limits) stays a code-only constant in balance.ts by design.
import { db } from "./db.ts";
import {
  ECOLOGY_ANCHOR_TARGET_DENSITY,
  ECOLOGY_BACKGROUND_TARGET_DENSITY,
  ECOLOGY_REGEN_DEADLINE_MAX_MS,
  ECOLOGY_REGEN_DEADLINE_MIN_MS,
} from "./balance.ts";

export interface EcologyConfig {
  anchorBaseTarget: number;
  backgroundBaseTarget: number;
  regenDelayMinMs: number;
  regenDelayMaxMs: number;
  updatedAt: string;
}

interface EcologyConfigRow {
  anchor_base_target: number;
  background_base_target: number;
  regen_delay_min_ms: number;
  regen_delay_max_ms: number;
  updated_at: string;
}

const selectStmt = db.prepare(
  "SELECT anchor_base_target, background_base_target, regen_delay_min_ms, regen_delay_max_ms, updated_at FROM ecology_config WHERE id = 1",
);

function rowToConfig(row: EcologyConfigRow): EcologyConfig {
  return {
    anchorBaseTarget: row.anchor_base_target,
    backgroundBaseTarget: row.background_base_target,
    regenDelayMinMs: row.regen_delay_min_ms,
    regenDelayMaxMs: row.regen_delay_max_ms,
    updatedAt: row.updated_at,
  };
}

// Cached in-memory so every ecology tick / snapshot call doesn't need its
// own SQLite round trip (advanceEcology runs every 5s, getEcologySnapshot
// can be polled every ~1.5s from the admin map — neither should pay a
// query for four numbers that only change when an admin explicitly saves).
let cached: EcologyConfig | null = null;

function loadFromDb(): EcologyConfig {
  const row = selectStmt.get() as EcologyConfigRow | undefined;
  if (!row) {
    // The CREATE TABLE + INSERT OR IGNORE in db.ts always seeds row id=1 at
    // boot, so this only happens inside a test that reset the DB without
    // reseeding — fall back to the documented Stage 12 defaults rather than
    // throwing.
    return {
      anchorBaseTarget: ECOLOGY_ANCHOR_TARGET_DENSITY,
      backgroundBaseTarget: ECOLOGY_BACKGROUND_TARGET_DENSITY,
      regenDelayMinMs: ECOLOGY_REGEN_DEADLINE_MIN_MS,
      regenDelayMaxMs: ECOLOGY_REGEN_DEADLINE_MAX_MS,
      updatedAt: new Date(0).toISOString(),
    };
  }
  return rowToConfig(row);
}

export function getEcologyConfig(): EcologyConfig {
  if (!cached) cached = loadFromDb();
  return cached;
}

export interface EcologyConfigInput {
  anchorBaseTarget: number;
  backgroundBaseTarget: number;
  regenDelayMinMs: number;
  regenDelayMaxMs: number;
}

const MIN_REGEN_DELAY_FLOOR_MS = 1000;

// Returns a validation error message, or null if the input is valid.
export function validateEcologyConfigInput(input: Partial<Record<keyof EcologyConfigInput, unknown>>): string | null {
  const { anchorBaseTarget, backgroundBaseTarget, regenDelayMinMs, regenDelayMaxMs } = input;
  for (const [name, value] of Object.entries({ anchorBaseTarget, backgroundBaseTarget, regenDelayMinMs, regenDelayMaxMs })) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return `${name} must be a finite number`;
    }
  }
  const a = anchorBaseTarget as number;
  const b = backgroundBaseTarget as number;
  const min = regenDelayMinMs as number;
  const max = regenDelayMaxMs as number;
  if (a <= 0) return "anchorBaseTarget must be greater than 0";
  if (b <= 0) return "backgroundBaseTarget must be greater than 0";
  if (min < MIN_REGEN_DELAY_FLOOR_MS) return `regenDelayMinMs must be at least ${MIN_REGEN_DELAY_FLOOR_MS}`;
  if (max < MIN_REGEN_DELAY_FLOOR_MS) return `regenDelayMaxMs must be at least ${MIN_REGEN_DELAY_FLOOR_MS}`;
  if (min > max) return "regenDelayMinMs must be less than or equal to regenDelayMaxMs";
  return null;
}

const updateStmt = db.prepare(
  "UPDATE ecology_config SET anchor_base_target = ?, background_base_target = ?, regen_delay_min_ms = ?, regen_delay_max_ms = ?, updated_at = datetime('now') WHERE id = 1",
);

// Caller is responsible for validating first (validateEcologyConfigInput) —
// this never partially writes, and always refreshes the cache + returns the
// server-authoritative saved row so the caller can echo it back verbatim.
export function setEcologyConfig(input: EcologyConfigInput): EcologyConfig {
  updateStmt.run(input.anchorBaseTarget, input.backgroundBaseTarget, input.regenDelayMinMs, input.regenDelayMaxMs);
  cached = loadFromDb();
  return cached;
}

export function resetEcologyConfigForTests(): void {
  cached = null;
}
