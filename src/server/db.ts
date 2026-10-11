import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { RESOURCE_NODES, RESOURCE_TYPES, STARTING_WORKERS, WORLD } from "./balance.ts";

// DB_PATH is overridable so isolated tests (spec/simulation.test.ts) can point
// at a throwaway file instead of sharing the dev DB or the deployed volume.
const DB_PATH = process.env.DB_PATH ?? (existsSync("/data") ? "/data/colony.db" : "./.data/colony.db");
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

dropLegacySchema();
migrateWorkersCarrying();

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

  CREATE TABLE IF NOT EXISTS resource_nodes (
    id INTEGER PRIMARY KEY,
    world_id INTEGER NOT NULL REFERENCES worlds(id),
    x REAL NOT NULL,
    y REAL NOT NULL,
    resource_type TEXT NOT NULL,
    amount REAL,
    max_amount REAL
  );
`);

seedIfEmpty();

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
    DELETE FROM worlds;
  `);
  seedIfEmpty();
}
