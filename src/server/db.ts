import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { STARTING_WORKERS, WORLD } from "./balance.ts";

// /data is the Fly volume (mounted in the container, present in CI as a
// tmpfs too); ./.data is local dev, gitignored.
const DB_PATH = existsSync("/data") ? "/data/colony.db" : "./.data/colony.db";
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS colonies (
    id INTEGER PRIMARY KEY,
    protein INTEGER NOT NULL DEFAULT 0,
    queen_x INTEGER NOT NULL,
    queen_y INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS workers (
    id INTEGER PRIMARY KEY,
    colony_id INTEGER NOT NULL REFERENCES colonies(id),
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS resource_nodes (
    id INTEGER PRIMARY KEY,
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    resource_type TEXT NOT NULL DEFAULT 'food'
  );
`);

seedIfEmpty();

function seedIfEmpty(): void {
  const row = db.prepare("SELECT COUNT(*) AS n FROM colonies").get() as { n: number };
  if (row.n > 0) return;

  const queenX = Math.floor(WORLD.width / 2);
  const queenY = Math.floor(WORLD.height / 2);
  const { lastInsertRowid: colonyId } = db
    .prepare("INSERT INTO colonies (protein, queen_x, queen_y) VALUES (0, ?, ?)")
    .run(queenX, queenY);

  const insertWorker = db.prepare("INSERT INTO workers (colony_id, x, y) VALUES (?, ?, ?)");
  for (let i = 0; i < STARTING_WORKERS; i++) {
    insertWorker.run(colonyId, queenX + i - 1, queenY + 1);
  }

  const insertNode = db.prepare(
    "INSERT INTO resource_nodes (x, y, resource_type) VALUES (?, ?, 'food')",
  );
  for (const [x, y] of WORLD.foodNodes) insertNode.run(x, y);
}
