import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  APHID_MAX_HEALTH,
  APHID_SEED_POSITIONS,
  colonySpiralPosition,
  RESOURCE_NODES,
  RESOURCE_TYPES,
  SPECIES_MAX_HEALTH,
  STARTING_PROTEIN,
  STARTING_WORKERS,
  SUGAR_NODE_MAX_AMOUNT,
  WORKER_MAX_HEALTH,
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
migrateWorkerHealth();

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

  -- Worker commands (idle/move/gather/return/attack) are never persisted
  -- here — they live only in in-memory simulation state. This table only
  -- ever gets columns that must survive a restart: position, (Stage 4)
  -- carrying — NULL/NULL means "not carrying" — and (Stage 7) health.
  -- health/max_health are nullable so a fresh ALTER on an already-deployed
  -- DB is cheap; backfillWorkerHealth() fills them in immediately. See
  -- CLAUDE.md.
  CREATE TABLE IF NOT EXISTS workers (
    id INTEGER PRIMARY KEY,
    colony_id INTEGER NOT NULL REFERENCES colonies(id),
    x REAL NOT NULL,
    y REAL NOT NULL,
    carrying_type TEXT,
    carrying_amount REAL,
    health REAL,
    max_health REAL,
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

  -- Crit 10: one row per anonymous browser session, mapping it to the one
  -- colony it owns. The session id itself is the cookie value (an opaque
  -- random token, never a password/account) — durable here so a returning
  -- cookie resolves to the same colony across a server restart, not just
  -- within one process's lifetime. See CLAUDE.md's Crit 10 section.
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    colony_id INTEGER NOT NULL REFERENCES colonies(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Crit 10: durable, queryable record of "who did what" — GET /api/log
  -- reads this straight back. colony_id is the acting colony (the only
  -- identity that exists in an anonymous-session model); detail is
  -- free-form JSON, never parsed back into relational columns because the
  -- shape differs per action type and nothing needs to query inside it.
  CREATE TABLE IF NOT EXISTS action_log (
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    colony_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    detail TEXT
  );
`);

seedIfEmpty();
seedCreaturesIfEmpty();
backfillCreatureHealth();
backfillWorkerHealth();

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

// Stage 7: workers gain durable health. Nullable so the ALTER is cheap;
// backfillWorkerHealth() immediately fills every row via WORKER_MAX_HEALTH,
// so "health IS NULL" never persists past one boot. Mirrors
// migrateCreatureHealth()'s guard pattern exactly.
function migrateWorkerHealth(): void {
  const columns = db.prepare("PRAGMA table_info(workers)").all() as { name: string }[];
  if (columns.length === 0) return; // table doesn't exist yet; CREATE TABLE below defines it with the columns
  if (columns.some((c) => c.name === "health")) return;
  db.exec(`
    ALTER TABLE workers ADD COLUMN health REAL;
    ALTER TABLE workers ADD COLUMN max_health REAL;
  `);
}

// Idempotent: only rows with max_health IS NULL match (brand-new rows from
// spawnStartingWorkers/reproduce already insert health/max_health directly).
// Runs every boot, mirroring backfillCreatureHealth().
function backfillWorkerHealth(): void {
  db.prepare("UPDATE workers SET health = ?, max_health = ? WHERE max_health IS NULL").run(
    WORKER_MAX_HEALTH,
    WORKER_MAX_HEALTH,
  );
}

// Pre-Crit-10 this was "the" one global colony. It still seeds exactly the
// same way (same world-centre queen position, same 3 starting workers) — but
// as of Crit 10 it starts out unowned, and becomes whichever session asks
// for a colony first (see getUnclaimedColonyId()/sessions.ts's
// resolveOrCreateColony). That's deliberate continuity, not a migration: the
// original Crit 8 colony becomes player one's colony instead of being thrown
// away, and it's also what keeps this function's pre-Crit-10 contract exactly
// intact for spec/simulation.test.ts, which captures `colonies LIMIT 1` at
// module load time and expects it to already exist.
function seedIfEmpty(): void {
  const row = db.prepare("SELECT COUNT(*) AS n FROM colonies").get() as { n: number };
  if (row.n > 0) return;

  const { lastInsertRowid: worldId } = db
    .prepare("INSERT INTO worlds (width, height) VALUES (?, ?)")
    .run(WORLD.width, WORLD.height);

  const queenX = WORLD.width / 2;
  const queenY = WORLD.height / 2;
  const { lastInsertRowid: colonyRowId } = db
    .prepare("INSERT INTO colonies (world_id, queen_x, queen_y) VALUES (?, ?, ?)")
    .run(worldId, queenX, queenY);
  const colonyId = Number(colonyRowId);

  seedColonyResources(colonyId);
  spawnStartingWorkers(colonyId, queenX, queenY);

  const insertNode = db.prepare(
    "INSERT INTO resource_nodes (world_id, x, y, resource_type, amount, max_amount) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const node of RESOURCE_NODES) {
    insertNode.run(worldId, node.x, node.y, node.resourceType, node.amount, node.maxAmount);
  }
}

// Shared by seedIfEmpty() and createColony() so every colony — the original
// seeded one or a Crit-10 mint — starts under the exact same fair rules
// (Stage 6b). Protein starts at STARTING_PROTEIN (enough for one immediate
// reproduction); sugar/biomass start at 0, same as always.
function seedColonyResources(colonyId: number): void {
  const insertResourceBucket = db.prepare(
    "INSERT INTO colony_resources (colony_id, resource_type, amount) VALUES (?, ?, ?)",
  );
  for (const type of RESOURCE_TYPES) insertResourceBucket.run(colonyId, type, type === "protein" ? STARTING_PROTEIN : 0);
}

function spawnStartingWorkers(
  colonyId: number,
  queenX: number,
  queenY: number,
): { id: number; x: number; y: number; health: number; maxHealth: number }[] {
  const insertWorker = db.prepare(
    "INSERT INTO workers (colony_id, x, y, health, max_health) VALUES (?, ?, ?, ?, ?)",
  );
  const workers: { id: number; x: number; y: number; health: number; maxHealth: number }[] = [];
  for (let i = 0; i < STARTING_WORKERS; i++) {
    const x = queenX + (i - 1) * 50;
    const y = queenY + 50;
    const { lastInsertRowid } = insertWorker.run(colonyId, x, y, WORKER_MAX_HEALTH, WORKER_MAX_HEALTH);
    workers.push({ id: Number(lastInsertRowid), x, y, health: WORKER_MAX_HEALTH, maxHealth: WORKER_MAX_HEALTH });
  }
  return workers;
}

// Crit 10: a colony with no row in `sessions` pointing at it — at most ever
// the original seedIfEmpty() colony, and only until the first session claims
// it. createColony()'s golden-angle index (COUNT(*) FROM colonies) already
// accounts for this colony existing, so the first *freshly minted* colony
// correctly lands at spiral index 1, not 0.
export function getUnclaimedColonyId(): number | undefined {
  const row = db
    .prepare("SELECT c.id AS id FROM colonies c LEFT JOIN sessions s ON s.colony_id = c.id WHERE s.colony_id IS NULL LIMIT 1")
    .get() as { id: number } | undefined;
  return row?.id;
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
// (world=1, colony=1, workers=1/2/3, resource_nodes=1..RESOURCE_NODES.length),
// which is why spec/simulation.test.ts can capture `colony`/`world` once at
// import time and have them stay valid across every reset. Not used by
// production code — see resetProductionWorld() in scripts/reset-world.ts for
// the production-safe equivalent (Stage 6b).
export function resetForTests(): void {
  db.exec(`
    DELETE FROM resource_nodes;
    DELETE FROM workers;
    DELETE FROM colony_resources;
    DELETE FROM sessions;
    DELETE FROM action_log;
    DELETE FROM colonies;
    DELETE FROM creatures;
    DELETE FROM worlds;
  `);
  seedIfEmpty();
  seedCreaturesIfEmpty();
  backfillCreatureHealth();
  backfillWorkerHealth();
}

// Stage 6b: the production-safe, intentionally-invoked counterpart to
// resetForTests(). Run only via `pnpm reset:world -- --yes`
// (scripts/reset-world.ts), never automatically on boot/deploy/restart, and
// never exposed as an HTTP endpoint — a public destructive endpoint would
// let any visitor wipe every player's colony. Wipes gameplay state but
// deliberately leaves `action_log` untouched: Crit 10's accountability
// record should survive a playtest reset, not be erased by it (see
// CLAUDE.md's Stage 6b section). Sessions are wiped too — every returning
// browser's old `sid` cookie simply fails to resolve afterwards
// (getColonyForSession returns undefined), so resolveOrCreateColony mints it
// a brand-new colony exactly as it would for a first-time visitor. No
// dangling session -> colony reference is possible because sessions and
// colonies are wiped together, inside one transaction. Does not call
// logAction itself (that would import log.ts, which imports this module) —
// the caller (scripts/reset-world.ts) logs the event after this returns.
export function resetProductionWorld(): {
  colonies: number;
  workers: number;
  resourceNodes: number;
  creatures: number;
  sessionsCleared: number;
  actionLogPreservedRows: number;
} {
  const sessionsCleared = (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
  const actionLogPreservedRows = (db.prepare("SELECT COUNT(*) AS n FROM action_log").get() as { n: number }).n;

  const tx = db.transaction(() => {
    db.exec(`
      DELETE FROM resource_nodes;
      DELETE FROM workers;
      DELETE FROM colony_resources;
      DELETE FROM sessions;
      DELETE FROM colonies;
      DELETE FROM creatures;
      DELETE FROM worlds;
    `);
    seedIfEmpty();
    seedCreaturesIfEmpty();
    backfillCreatureHealth();
    backfillWorkerHealth();
  });
  tx();

  return {
    colonies: (db.prepare("SELECT COUNT(*) AS n FROM colonies").get() as { n: number }).n,
    workers: (db.prepare("SELECT COUNT(*) AS n FROM workers").get() as { n: number }).n,
    resourceNodes: (db.prepare("SELECT COUNT(*) AS n FROM resource_nodes").get() as { n: number }).n,
    creatures: (db.prepare("SELECT COUNT(*) AS n FROM creatures").get() as { n: number }).n,
    sessionsCleared,
    actionLogPreservedRows,
  };
}

// Crit 10: mints a brand-new colony — its own queen, starting workers, and
// zeroed resource ledger — for a session that doesn't already own one. One
// transaction: a session that gets this colony's id back must never observe
// a colony that exists without its workers or ledger, even across a crash
// mid-creation (same discipline Stage 4's claim/deposit transactions use for
// the same reason — see CLAUDE.md).
//
// Placement reuses computeGroupDestinations' golden-angle spiral (see
// balance.ts's GOLDEN_ANGLE/COLONY_SPACING), centred on the world instead of
// a click point, so successive colonies spread out deterministically instead
// of stacking — colony index 0 (the very first colony any world ever seeds)
// lands at radius 0, exactly (width/2, height/2), the pre-Crit-10
// single-colony seed position, unchanged.
export function createColony(): {
  colonyId: number;
  queenX: number;
  queenY: number;
  workers: { id: number; x: number; y: number; health: number; maxHealth: number }[];
} {
  const world = db.prepare("SELECT id FROM worlds LIMIT 1").get() as { id: number } | undefined;
  if (!world) throw new Error("no world seeded");

  const { n: index } = db.prepare("SELECT COUNT(*) AS n FROM colonies").get() as { n: number };
  const { x: queenX, y: queenY } = colonySpiralPosition(index);

  let colonyId = 0;
  let workers: { id: number; x: number; y: number; health: number; maxHealth: number }[] = [];
  const tx = db.transaction(() => {
    const colonyInfo = db
      .prepare("INSERT INTO colonies (world_id, queen_x, queen_y) VALUES (?, ?, ?)")
      .run(world.id, queenX, queenY);
    colonyId = Number(colonyInfo.lastInsertRowid);

    seedColonyResources(colonyId);
    workers = spawnStartingWorkers(colonyId, queenX, queenY);
  });
  tx();

  return { colonyId, queenX, queenY, workers };
}

// Crit 10: resolves a session cookie value to the colony it owns, or
// undefined if the cookie is missing/stale (e.g. from a wiped test DB).
export function getColonyForSession(sessionId: string): number | undefined {
  const row = db.prepare("SELECT colony_id AS colonyId FROM sessions WHERE id = ?").get(sessionId) as
    | { colonyId: number }
    | undefined;
  return row?.colonyId;
}

export function saveSession(sessionId: string, colonyId: number): void {
  db.prepare("INSERT INTO sessions (id, colony_id) VALUES (?, ?)").run(sessionId, colonyId);
}
