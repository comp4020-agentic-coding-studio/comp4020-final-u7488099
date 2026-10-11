import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  APHID_MAX_HEALTH,
  APHID_SEED_POSITIONS,
  RESOURCE_NODES,
  RESOURCE_TYPES,
  SPECIES_MAX_HEALTH,
  STARTING_WORKERS,
  SUGAR_NODE_MAX_AMOUNT,
  WORLD,
} from "./balance.ts";

// DB_PATH is overridable so isolated tests (spec/simulation.test.ts) can point
// at a throwaway file instead of sharing the dev DB or the deployed volume.
const DB_PATH = process.env.DB_PATH ?? (existsSync("/data") ? "/data/colony.db" : "./.data/colony.db");
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

dropLegacySchema();
migrateWorkersCarrying();
migrateSugarNodesFinite();
migrateResourceNodeKind();
migrateCreatureHealth();

db.exec(`
  CREATE TABLE IF NOT EXISTS worlds (
    id INTEGER PRIMARY KEY,
    width REAL NOT NULL,
    height REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS colonies (
    id INTEGER PRIMARY KEY,
    world_id INTEGER NOT NULL REFERENCES worlds(id),
    queen_x REAL NOT NULL,
    queen_y REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS colony_resources (
    colony_id INTEGER NOT NULL REFERENCES colonies(id),
    resource_type TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (colony_id, resource_type)
  );

  -- Worker commands (idle/move/gather/return) are never persisted here —
  -- they live only in in-memory simulation state. This table only ever gets
  -- columns that must survive a restart: position, and (Stage 4) carrying —
  -- NULL/NULL means "not carrying". See CLAUDE.md.
  CREATE TABLE IF NOT EXISTS workers (
    id INTEGER PRIMARY KEY,
    colony_id INTEGER NOT NULL REFERENCES colonies(id),
    x REAL NOT NULL,
    y REAL NOT NULL,
    carrying_type TEXT,
    carrying_amount REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Stage 6: 'kind' distinguishes a renewable, fixed-location "source"
  -- (sugar/biomass/protein nodes, unchanged) from a finite dropped "item"
  -- (a carcass). Defaults to 'source' so every pre-Stage-6 row is correctly
  -- classified with no backfill needed. See CLAUDE.md.
  CREATE TABLE IF NOT EXISTS resource_nodes (
    id INTEGER PRIMARY KEY,
    world_id INTEGER NOT NULL REFERENCES worlds(id),
    x REAL NOT NULL,
    y REAL NOT NULL,
    resource_type TEXT NOT NULL,
    amount REAL,
    max_amount REAL,
    kind TEXT NOT NULL DEFAULT 'source'
  );

  -- Stage 5: neutral, non-interactable creatures (first species: aphid).
  -- World-scoped rather than colony-scoped — aphids aren't owned by anyone.
  -- Stage 6 adds durable health/max_health (nullable so a fresh ALTER on an
  -- already-deployed DB is cheap; backfillCreatureHealth() fills them in
  -- immediately). See CLAUDE.md.
  CREATE TABLE IF NOT EXISTS creatures (
    id INTEGER PRIMARY KEY,
    world_id INTEGER NOT NULL REFERENCES worlds(id),
    species TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    health REAL,
    max_health REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

seedIfEmpty();
seedCreaturesIfEmpty();
backfillCreatureHealth();

// Pre-Stage-1 deployments have a `colonies` table from the Crit 8/9 schema:
// integer grid coordinates, a flat `protein` column, no `world_id`. That
// seeded state is a throwaway demo colony, not user data worth an ALTER
// TABLE migration, so Stage 1 detects the old shape and drops it in favour
// of a fresh, deterministic reseed under the new schema. See CLAUDE.md.
function dropLegacySchema(): void {
  const columns = db.prepare("PRAGMA table_info(colonies)").all() as { name: string }[];
  if (columns.length === 0) return; // first boot ever, nothing to drop
  const hasWorldId = columns.some((c) => c.name === "world_id");
  if (hasWorldId) return;
  db.exec(`
    DROP TABLE IF EXISTS resource_nodes;
    DROP TABLE IF EXISTS workers;
    DROP TABLE IF EXISTS colonies;
  `);
}

// Stage 4 added carrying_type/carrying_amount to the already-deployed
// `workers` table. `CREATE TABLE IF NOT EXISTS` above is a no-op against an
// existing table, so it would never add these columns in production — this
// guarded ALTER TABLE does, mirroring dropLegacySchema()'s PRAGMA-guard
// pattern. Every pre-Stage-4 row gets NULL/NULL, correctly meaning "not
// carrying" (no worker could have been carrying anything before this
// existed). See CLAUDE.md.
function migrateWorkersCarrying(): void {
  const columns = db.prepare("PRAGMA table_info(workers)").all() as { name: string }[];
  if (columns.length === 0) return; // table doesn't exist yet; CREATE TABLE below defines it with the columns
  if (columns.some((c) => c.name === "carrying_type")) return;
  db.exec(`
    ALTER TABLE workers ADD COLUMN carrying_type TEXT;
    ALTER TABLE workers ADD COLUMN carrying_amount REAL;
  `);
}

// Stage 5: sugar nodes change from infinite (amount: null) to finite +
// renewable. Idempotent — after the first run no sugar row has amount IS
// NULL left to match, so this is a no-op on every later boot.
function migrateSugarNodesFinite(): void {
  const columns = db.prepare("PRAGMA table_info(resource_nodes)").all() as { name: string }[];
  if (columns.length === 0) return; // table doesn't exist yet; CREATE TABLE + seedIfEmpty seed it finite directly
  db.prepare(
    "UPDATE resource_nodes SET amount = ?, max_amount = ? WHERE resource_type = 'sugar' AND amount IS NULL",
  ).run(SUGAR_NODE_MAX_AMOUNT, SUGAR_NODE_MAX_AMOUNT);
}

// Stage 6: distinguishes a renewable "source" from a finite dropped "item"
// (a carcass). Defaulting to 'source' means every existing row is correctly
// classified with no backfill UPDATE needed — only the ALTER itself.
function migrateResourceNodeKind(): void {
  const columns = db.prepare("PRAGMA table_info(resource_nodes)").all() as { name: string }[];
  if (columns.length === 0) return; // table doesn't exist yet; CREATE TABLE below defines it with the column
  if (columns.some((c) => c.name === "kind")) return;
  db.exec("ALTER TABLE resource_nodes ADD COLUMN kind TEXT NOT NULL DEFAULT 'source'");
}

// Stage 6: creatures gain durable health. Nullable so the ALTER is cheap;
// backfillCreatureHealth() immediately fills every row via SPECIES_MAX_HEALTH,
// so "health IS NULL" never persists past one boot. Mirrors
// migrateWorkersCarrying()'s guard pattern.
function migrateCreatureHealth(): void {
  const columns = db.prepare("PRAGMA table_info(creatures)").all() as { name: string }[];
  if (columns.length === 0) return; // table doesn't exist yet; CREATE TABLE below defines it with the columns
  if (columns.some((c) => c.name === "health")) return;
  db.exec(`
    ALTER TABLE creatures ADD COLUMN health REAL;
    ALTER TABLE creatures ADD COLUMN max_health REAL;
  `);
}

// Idempotent: only rows with max_health IS NULL match (brand-new rows from
// seedCreaturesIfEmpty already insert health/max_health directly). Runs
// every boot so a species added to SPECIES_MAX_HEALTH later also backfills.
function backfillCreatureHealth(): void {
  const backfill = db.prepare(
    "UPDATE creatures SET health = ?, max_health = ? WHERE species = ? AND max_health IS NULL",
  );
  for (const [species, maxHealth] of Object.entries(SPECIES_MAX_HEALTH)) {
    backfill.run(maxHealth, maxHealth, species);
  }
}

function seedIfEmpty(): void {
  const row = db.prepare("SELECT COUNT(*) AS n FROM colonies").get() as { n: number };
  if (row.n > 0) return;

  const { lastInsertRowid: worldId } = db
    .prepare("INSERT INTO worlds (width, height) VALUES (?, ?)")
    .run(WORLD.width, WORLD.height);

  const queenX = WORLD.width / 2;
  const queenY = WORLD.height / 2;
  const { lastInsertRowid: colonyId } = db
    .prepare("INSERT INTO colonies (world_id, queen_x, queen_y) VALUES (?, ?, ?)")
    .run(worldId, queenX, queenY);

  const insertResourceBucket = db.prepare(
    "INSERT INTO colony_resources (colony_id, resource_type, amount) VALUES (?, ?, 0)",
  );
  for (const type of RESOURCE_TYPES) insertResourceBucket.run(colonyId, type);

  const insertWorker = db.prepare("INSERT INTO workers (colony_id, x, y) VALUES (?, ?, ?)");
  for (let i = 0; i < STARTING_WORKERS; i++) {
    insertWorker.run(colonyId, queenX + (i - 1) * 50, queenY + 50);
  }

  const insertNode = db.prepare(
    "INSERT INTO resource_nodes (world_id, x, y, resource_type, amount, max_amount) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const node of RESOURCE_NODES) {
    insertNode.run(worldId, node.x, node.y, node.resourceType, node.amount, node.maxAmount);
  }
}

// Independent of seedIfEmpty()'s colonies-count gate: an already-deployed
// world has colonies > 0 (seedIfEmpty no-ops) but creatures = 0 (this still
// fires), so Stage 5 backfills aphids into existing worlds too. Called after
// seedIfEmpty() so a brand-new world's row already exists either way.
function seedCreaturesIfEmpty(): void {
  const row = db.prepare("SELECT COUNT(*) AS n FROM creatures").get() as { n: number };
  if (row.n > 0) return;
  const world = db.prepare("SELECT id FROM worlds LIMIT 1").get() as { id: number } | undefined;
  if (!world) return;
  const insertCreature = db.prepare(
    "INSERT INTO creatures (world_id, species, x, y, health, max_health) VALUES (?, 'aphid', ?, ?, ?, ?)",
  );
  for (const pos of APHID_SEED_POSITIONS) {
    insertCreature.run(world.id, pos.x, pos.y, APHID_MAX_HEALTH, APHID_MAX_HEALTH);
  }
}

// Test-only isolation seam (Stage 4): wipes every table, then reseeds via
// seedIfEmpty(). None of these tables use AUTOINCREMENT, so SQLite reuses
// the lowest free rowid — every reset reproduces the exact same ids
// (world=1, colony=1, workers=1/2/3, resource_nodes=1..12), which is why
// spec/simulation.test.ts can capture `colony`/`world` once at import time
// and have them stay valid across every reset. Not used by production code.
export function resetForTests(): void {
  db.exec(`
    DELETE FROM resource_nodes;
    DELETE FROM workers;
    DELETE FROM colony_resources;
    DELETE FROM colonies;
    DELETE FROM creatures;
    DELETE FROM worlds;
  `);
  seedIfEmpty();
  seedCreaturesIfEmpty();
  backfillCreatureHealth();
}
