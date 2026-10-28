import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  APHID_SEED_POSITIONS,
  BIOMASS_NODE_MAX_AMOUNT,
  type Caste,
  colonySpiralPosition,
  PROTEIN_NODE_AMOUNT,
  QUEEN_MAX_HEALTH,
  RESOURCE_NODES,
  RESOURCE_TYPES,
  SPECIES_MAX_HEALTH,
  SPIDER_SEED_POSITIONS,
  STARTING_PROTEIN,
  STARTING_WORKERS,
  SUGAR_NODE_MAX_AMOUNT,
  WORKER_MAX_HEALTH,
  WORLD,
} from "./balance.ts";
import { DEFAULT_SCRYPT_PARAMS, hashPassword, type PasswordHash } from "./password.ts";

// Stage 7: seedCreaturesIfEmpty() loops over every species' seed-position
// list instead of hardcoding 'aphid', so a brand-new world seeds spiders
// alongside aphids in the same empty-table pass. The same function also
// folds in the legacy pre-Stage-7 top-up (a world that already has aphids
// but was never seeded with spiders at all) — see seedCreaturesIfEmpty()'s
// own comment for why this is gated on a one-time marker column, not a live
// species count (Stage 12 fix). Declared here (not next to
// seedCreaturesIfEmpty further down) because the module-level
// seedCreaturesIfEmpty() call below runs before a `const` declared later in
// the file would be initialized.
const SPECIES_SEED_POSITIONS: Record<string, { x: number; y: number }[]> = {
  aphid: APHID_SEED_POSITIONS,
  spider: SPIDER_SEED_POSITIONS,
};

// DB_PATH is overridable so isolated tests (spec/simulation.test.ts) can point
// at a throwaway file instead of sharing the dev DB or the deployed volume.
const DB_PATH = process.env.DB_PATH ?? (existsSync("/data") ? "/data/colony.db" : "./.data/colony.db");
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

dropLegacySchema();
migrateWorkersCarrying();
migrateResourceNodesFinite();
migrateResourceNodeKind();
migrateCreatureHealth();
migrateWorkerHealth();
migrateColonyLifecycle();
migrateColonyEvolution();
migrateWorkerCaste();
migrateSessionsAccountId();
migrateActionLogAccountId();
migrateWorldsCreaturesSeeded();

db.exec(`
  -- Stage 12: creatures_seeded is a durable, one-time "initial population
  -- already established" marker — see migrateWorldsCreaturesSeeded() and
  -- seedCreaturesIfEmpty() below for why this exists (replaces a bug where
  -- a live species count was used as the gate, letting a routine restart
  -- undo a legitimate in-game extinction). Defaults to 0 so a brand-new
  -- world (via seedIfEmpty() or a full reset) is always still seeded once.
  CREATE TABLE IF NOT EXISTS worlds (
    id INTEGER PRIMARY KEY,
    width REAL NOT NULL,
    height REAL NOT NULL,
    creatures_seeded INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Stage 8: colonies gain a durable lifecycle. status/queen_health/
  -- queen_max_health are nullable so a fresh ALTER on an already-deployed DB
  -- is cheap; backfillColonyLifecycle() fills them in immediately.
  -- defeat_cause/defeated_at stay NULL for every colony that's never been
  -- defeated. See CLAUDE.md.
  -- Stage 9: peak_population and the three evolution_tier columns belong to
  -- the colony LINEAGE, not the session — a ruin keeps them forever, and a
  -- replacement colony via Start New Colony never inherits them (see
  -- createColony()). evolution_tierN is one of 'foraging'/'survival'/'brood'
  -- or NULL ("no selection made for this tier yet"); nullable for the same
  -- cheap-ALTER reason as every other lifecycle column here.
  CREATE TABLE IF NOT EXISTS colonies (
    id INTEGER PRIMARY KEY,
    world_id INTEGER NOT NULL REFERENCES worlds(id),
    queen_x REAL NOT NULL,
    queen_y REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    queen_health REAL,
    queen_max_health REAL,
    defeat_cause TEXT,
    defeated_at TEXT,
    peak_population INTEGER,
    evolution_tier1 TEXT,
    evolution_tier2 TEXT,
    evolution_tier3 TEXT,
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
  -- Stage 10: caste is a durable, persistent property of the unit (worker/
  -- soldier/scout). 'worker' is the only honest default for every row that
  -- predates castes — unlike status/peak_population above, a constant
  -- string default needs no separate nullable+backfill step; SQLite's
  -- ALTER TABLE ADD COLUMN supports NOT NULL DEFAULT '<constant>' directly
  -- (see migrateWorkerCaste()). See CLAUDE.md.
  CREATE TABLE IF NOT EXISTS workers (
    id INTEGER PRIMARY KEY,
    colony_id INTEGER NOT NULL REFERENCES colonies(id),
    x REAL NOT NULL,
    y REAL NOT NULL,
    carrying_type TEXT,
    carrying_amount REAL,
    health REAL,
    max_health REAL,
    caste TEXT NOT NULL DEFAULT 'worker',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Stage 6: 'kind' distinguishes a world-generated/ecology-spawned
  -- "source" (sugar/biomass/protein nodes) from a dropped "item" (a
  -- carcass) — both are finite and delete-at-zero as of Stage 12.5, with no
  -- renewal in place for either. Defaults to 'source' so every pre-Stage-6
  -- row is correctly classified with no backfill needed. See CLAUDE.md.
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

  -- Crit 10: one row per browser session, mapping it to the one colony it
  -- owns. The session id itself is the cookie value (an opaque random
  -- token, never a password/account) — durable here so a returning cookie
  -- resolves to the same colony across a server restart, not just within
  -- one process's lifetime. See CLAUDE.md's Crit 10 section.
  -- Stage 11: account_id is nullable — NULL means an anonymous guest
  -- session, exactly the only kind that existed before this column did, so
  -- colony_id keeps meaning what it always meant for every pre-Stage-11 row.
  -- When account_id IS set, colony_id is vestigial (never cleared, never
  -- read) — the authoritative colony for an authenticated session is always
  -- accounts.active_colony_id, looked up fresh. See sessions.ts/auth.ts.
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    colony_id INTEGER NOT NULL REFERENCES colonies(id),
    account_id INTEGER REFERENCES accounts(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Crit 10: durable, queryable record of "who did what" — GET /api/log
  -- reads this straight back. colony_id is the acting colony (the only
  -- identity that existed in the original anonymous-session model); detail
  -- is free-form JSON, never parsed back into relational columns because
  -- the shape differs per action type and nothing needs to query inside it.
  -- Stage 11: account_id is nullable — set only for actions taken by an
  -- authenticated session (login/register/reset-progress/admin actions),
  -- NULL for every guest action, exactly as before this column existed.
  CREATE TABLE IF NOT EXISTS action_log (
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    colony_id INTEGER NOT NULL,
    account_id INTEGER,
    action TEXT NOT NULL,
    detail TEXT
  );

  -- Stage 11: one row per registered account. username uniqueness is
  -- DB-enforced and case-insensitive (COLLATE NOCASE) so "Alice" and "alice"
  -- can never both register. Password is never stored in any recoverable
  -- form — only a scrypt hash + its own random salt; scrypt_n/r/p are
  -- stored per-row (not read from a shared constant) so a future change to
  -- the cost parameters never invalidates already-issued hashes.
  -- active_colony_id is the authoritative "current colony" for every
  -- session with account_id pointing here — looked up fresh on every
  -- request, never cached (see getColonyForSession()/Stage 8's lesson).
  -- No email column: email verification/password-reset-by-email is an
  -- explicit Stage 11 non-goal.
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    scrypt_n INTEGER NOT NULL,
    scrypt_r INTEGER NOT NULL,
    scrypt_p INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'player',
    active_colony_id INTEGER REFERENCES colonies(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

seedIfEmpty();
backfillWorldsCreaturesSeeded();
seedCreaturesIfEmpty();
backfillCreatureHealth();
backfillWorkerHealth();
backfillColonyLifecycle();
backfillColonyEvolution();
bootstrapAdminAccount();

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

// Stage 5 introduced this for sugar only (amount: null -> finite +
// renewable); Stage 12 makes finite resources a global invariant, so this
// now backfills every resource_type via its own finite default, not just
// sugar. Idempotent — after the first run no row has amount IS NULL left to
// match, so this is a no-op on every later boot. Schema itself stays
// nullable (SQLite can't retroactively add NOT NULL) — the invariant is
// enforced by this migration plus the application code, same pattern as
// every other backfill migration in this file.
function migrateResourceNodesFinite(): void {
  const columns = db.prepare("PRAGMA table_info(resource_nodes)").all() as { name: string }[];
  if (columns.length === 0) return; // table doesn't exist yet; CREATE TABLE + seedIfEmpty seed it finite directly
  // Declared locally, not at module scope: this function runs at module-load
  // time (see the top-of-file migration call sequence), before a module-level
  // const initializer here would have run — a TDZ ReferenceError.
  const FINITE_DEFAULT_AMOUNT: Record<string, number> = {
    sugar: SUGAR_NODE_MAX_AMOUNT,
    biomass: BIOMASS_NODE_MAX_AMOUNT,
    protein: PROTEIN_NODE_AMOUNT,
  };
  const stmt = db.prepare(
    "UPDATE resource_nodes SET amount = ?, max_amount = ? WHERE resource_type = ? AND (amount IS NULL OR max_amount IS NULL)",
  );
  for (const [resourceType, defaultAmount] of Object.entries(FINITE_DEFAULT_AMOUNT)) {
    stmt.run(defaultAmount, defaultAmount, resourceType);
  }
}

// Stage 6: distinguishes a world-generated/ecology-spawned "source" from a
// dropped "item" (a carcass) — both finite and delete-at-zero as of Stage
// 12.5. Defaulting to 'source' means every existing row is correctly
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

// Stage 8: colonies gain a durable lifecycle (status/queen health/defeat
// info). Nullable so the ALTER is cheap; backfillColonyLifecycle()
// immediately fills every pre-existing row via QUEEN_MAX_HEALTH and
// status='active' (every colony that exists before this migration ships is,
// by definition, still an ordinary undefeated colony). Mirrors
// migrateWorkerHealth()'s guard pattern exactly. Note: SQLite can't
// retroactively apply a NOT NULL/DEFAULT constraint to an already-existing
// column via ALTER TABLE, so `status` stays nullable here even though the
// CREATE TABLE above declares it NOT NULL DEFAULT 'active' for fresh DBs —
// the backfill below is what actually guarantees no row is ever left with a
// NULL status in practice.
function migrateColonyLifecycle(): void {
  const columns = db.prepare("PRAGMA table_info(colonies)").all() as { name: string }[];
  if (columns.length === 0) return; // table doesn't exist yet; CREATE TABLE below defines it with the columns
  if (columns.some((c) => c.name === "status")) return;
  db.exec(`
    ALTER TABLE colonies ADD COLUMN status TEXT;
    ALTER TABLE colonies ADD COLUMN queen_health REAL;
    ALTER TABLE colonies ADD COLUMN queen_max_health REAL;
    ALTER TABLE colonies ADD COLUMN defeat_cause TEXT;
    ALTER TABLE colonies ADD COLUMN defeated_at TEXT;
  `);
}

// Idempotent: only rows with status IS NULL match (brand-new rows from
// seedIfEmpty/createColony already insert status/health directly). Runs
// every boot, mirroring backfillWorkerHealth().
function backfillColonyLifecycle(): void {
  db.prepare("UPDATE colonies SET status = 'active', queen_health = ?, queen_max_health = ? WHERE status IS NULL").run(
    QUEEN_MAX_HEALTH,
    QUEEN_MAX_HEALTH,
  );
}

// Stage 9: colonies gain peak_population + three evolution tier columns.
// Nullable so the ALTER is cheap; backfillColonyEvolution() immediately
// fills peak_population for every pre-existing row. Mirrors
// migrateColonyLifecycle()'s guard pattern exactly.
function migrateColonyEvolution(): void {
  const columns = db.prepare("PRAGMA table_info(colonies)").all() as { name: string }[];
  if (columns.length === 0) return; // table doesn't exist yet; CREATE TABLE below defines it with the columns
  if (columns.some((c) => c.name === "peak_population")) return;
  db.exec(`
    ALTER TABLE colonies ADD COLUMN peak_population INTEGER;
    ALTER TABLE colonies ADD COLUMN evolution_tier1 TEXT;
    ALTER TABLE colonies ADD COLUMN evolution_tier2 TEXT;
    ALTER TABLE colonies ADD COLUMN evolution_tier3 TEXT;
  `);
}

// Idempotent: only rows with peak_population IS NULL match (brand-new rows
// from seedIfEmpty/createColony already insert peak_population directly).
// Backfills a safe, conservative floor — a colony's true historical peak may
// have been higher than its current living-worker count, but nothing
// recorded that before this migration existed, and the brief (§3/§32)
// explicitly calls for a conservative floor over fabricated history. An
// already-defeated colony has zero living workers (defeatColony() deletes
// them), so its floor is simply 1 — it did, at minimum, once have its queen
// and starting workers. evolution_tier1/2/3 are deliberately left NULL here
// (not backfilled to anything): "no selection ever made" is the only honest
// value for a colony that existed before evolution did.
function backfillColonyEvolution(): void {
  const colonyIds = db.prepare("SELECT id FROM colonies WHERE peak_population IS NULL").all() as { id: number }[];
  const countWorkers = db.prepare("SELECT COUNT(*) AS n FROM workers WHERE colony_id = ?");
  const setPeak = db.prepare("UPDATE colonies SET peak_population = ? WHERE id = ?");
  for (const { id } of colonyIds) {
    const { n } = countWorkers.get(id) as { n: number };
    setPeak.run(Math.max(n, 1), id);
  }
}

// Stage 10: workers gain a durable caste column. Unlike migrateWorkerHealth
// (health has no single honest default), 'worker' is the only honest value
// for every row that predates castes — Soldier/Scout never existed before
// this stage — so this ALTER adds NOT NULL DEFAULT 'worker' directly and
// needs no separate backfillWorkerCaste() pass: SQLite applies the default
// to every existing row as part of the ALTER itself. Mirrors
// migrateWorkerHealth()'s guard pattern.
function migrateWorkerCaste(): void {
  const columns = db.prepare("PRAGMA table_info(workers)").all() as { name: string }[];
  if (columns.length === 0) return; // table doesn't exist yet; CREATE TABLE below defines it with the column
  if (columns.some((c) => c.name === "caste")) return;
  db.exec("ALTER TABLE workers ADD COLUMN caste TEXT NOT NULL DEFAULT 'worker'");
}

// Stage 11: sessions gain an optional account_id. NULL is the exactly-
// correct value for every pre-Stage-11 row (a guest session, which is all
// that existed before accounts did) — no backfill needed, mirrors
// migrateWorkersCarrying()'s guard pattern.
function migrateSessionsAccountId(): void {
  const columns = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  if (columns.length === 0) return; // table doesn't exist yet; CREATE TABLE below defines it with the column
  if (columns.some((c) => c.name === "account_id")) return;
  db.exec("ALTER TABLE sessions ADD COLUMN account_id INTEGER REFERENCES accounts(id)");
}

// Stage 11: action_log gains an optional account_id, NULL for every
// pre-Stage-11 row (every action before accounts existed was taken by a
// guest session) — same reasoning as migrateSessionsAccountId().
function migrateActionLogAccountId(): void {
  const columns = db.prepare("PRAGMA table_info(action_log)").all() as { name: string }[];
  if (columns.length === 0) return; // table doesn't exist yet; CREATE TABLE below defines it with the column
  if (columns.some((c) => c.name === "account_id")) return;
  db.exec("ALTER TABLE action_log ADD COLUMN account_id INTEGER");
}

// Stage 12: worlds gain a durable one-time "initial creature population
// already established" marker, replacing the live species-count gate that
// seedSpidersIfMissing() used to use (COUNT(*) FROM creatures WHERE
// species='spider' == 0) — that gate couldn't distinguish "this world
// predates spiders/aphids entirely" from "this world legitimately had them
// hunted to extinction by players/ecology," so any restart after a real
// extinction silently undid it. ALTER adds the column NOT NULL DEFAULT 0 so
// every pre-existing row starts unseeded; backfillWorldsCreaturesSeeded()
// immediately marks any world that already has at least one creature as
// seeded, so an existing world with living creatures is never re-seeded on
// the very next boot after this migration ships. A world with zero
// creatures at the moment this migration runs is deliberately left
// unmarked — ambiguous between "never had any" and "already extinct before
// this fix shipped," and seedCreaturesIfEmpty() resolves that ambiguity the
// same way a fresh world always has: by seeding it once, exactly here, one
// time only. Mirrors migrateWorkerCaste()'s ALTER ... DEFAULT pattern.
function migrateWorldsCreaturesSeeded(): void {
  const columns = db.prepare("PRAGMA table_info(worlds)").all() as { name: string }[];
  if (columns.length === 0) return; // table doesn't exist yet; CREATE TABLE below defines it with the column
  if (columns.some((c) => c.name === "creatures_seeded")) return;
  db.exec("ALTER TABLE worlds ADD COLUMN creatures_seeded INTEGER NOT NULL DEFAULT 0");
}

// Idempotent: only marks a world that isn't already marked AND already has
// at least one creature — a world with zero creatures right now is left
// unmarked so seedCreaturesIfEmpty() below still seeds it exactly once (see
// migrateWorldsCreaturesSeeded()'s comment for the full reasoning). Runs
// every boot; a no-op once every existing world has been classified.
function backfillWorldsCreaturesSeeded(): void {
  db.exec(`
    UPDATE worlds SET creatures_seeded = 1
    WHERE creatures_seeded = 0
      AND EXISTS (SELECT 1 FROM creatures WHERE creatures.world_id = worlds.id)
  `);
}

// Stage 11: idempotent create-or-promote admin bootstrap, run on every boot.
// ADMIN_USERNAME/ADMIN_PASSWORD are set via `flyctl secrets set` in
// production and a gitignored mise.local.toml in dev — never committed to
// the repo. A no-op if either env var is unset. Never resets an existing
// admin's password on reboot: an operator may have since changed it via the
// normal login flow, and clobbering that every redeploy would be hostile.
function bootstrapAdminAccount(): void {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) return;

  const existing = db.prepare("SELECT id, role FROM accounts WHERE username = ? COLLATE NOCASE").get(username) as
    | { id: number; role: string }
    | undefined;

  if (existing) {
    if (existing.role !== "admin") {
      db.prepare("UPDATE accounts SET role = 'admin' WHERE id = ?").run(existing.id);
    }
    return;
  }

  const { hash, salt, params } = hashPassword(password, DEFAULT_SCRYPT_PARAMS);
  db.prepare(
    "INSERT INTO accounts (username, password_hash, password_salt, scrypt_n, scrypt_r, scrypt_p, role) VALUES (?, ?, ?, ?, ?, ?, 'admin')",
  ).run(username, hash, salt, params.n, params.r, params.p);
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
    .prepare(
      "INSERT INTO colonies (world_id, queen_x, queen_y, status, queen_health, queen_max_health, peak_population) VALUES (?, ?, ?, 'active', ?, ?, ?)",
    )
    .run(worldId, queenX, queenY, QUEEN_MAX_HEALTH, QUEEN_MAX_HEALTH, STARTING_WORKERS);
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

// Stage 10 (§37/§38): every starting/replacement-colony worker is explicitly
// pinned to caste='worker' here — not left to rely on the column default —
// so a pre-minted spare colony or a fresh "Start New Colony" can never
// accidentally spawn a Soldier/Scout, matching this codebase's standing
// discipline of explicit-at-insert over backfill-reliant for anything a
// spawn path controls.
function spawnStartingWorkers(
  colonyId: number,
  queenX: number,
  queenY: number,
): { id: number; x: number; y: number; health: number; maxHealth: number; caste: Caste }[] {
  const insertWorker = db.prepare(
    "INSERT INTO workers (colony_id, x, y, health, max_health, caste) VALUES (?, ?, ?, ?, ?, 'worker')",
  );
  const workers: { id: number; x: number; y: number; health: number; maxHealth: number; caste: Caste }[] = [];
  for (let i = 0; i < STARTING_WORKERS; i++) {
    const x = queenX + (i - 1) * 50;
    const y = queenY + 50;
    const { lastInsertRowid } = insertWorker.run(colonyId, x, y, WORKER_MAX_HEALTH, WORKER_MAX_HEALTH);
    workers.push({
      id: Number(lastInsertRowid),
      x,
      y,
      health: WORKER_MAX_HEALTH,
      maxHealth: WORKER_MAX_HEALTH,
      caste: "worker",
    });
  }
  return workers;
}

// Crit 10: a colony with no row in `sessions` pointing at it — at most ever
// the original seedIfEmpty() colony, and only until the first session claims
// it. createColony()'s golden-angle index (COUNT(*) FROM colonies) already
// accounts for this colony existing, so the first *freshly minted* colony
// correctly lands at spiral index 1, not 0.
// Stage 8: the `status = 'active'` filter closes an edge case that didn't
// exist before colonies could be defeated — a never-claimed spare colony
// killed by a spider before any session claims it must not be handed out as
// someone's "fresh" colony. A defeated, unclaimed spare is simply invisible
// here; the very next claim attempt mints a brand-new one in its place (see
// sessions.ts), same as today's "mint if none unclaimed" behavior.
// Stage 11: also excludes any colony already claimed via
// accounts.active_colony_id. claimFreshColony() (sessions.ts) is used by the
// account-based register()/login()/resetProgress() paths, which record a
// claim via setAccountColony() — never a sessions row — so without this
// second exclusion, a colony an account just claimed would still look
// "unclaimed" here and get handed out again to the very next guest/account
// claim, silently giving two identities the same colony.
export function getUnclaimedColonyId(): number | undefined {
  const row = db
    .prepare(
      `SELECT c.id AS id FROM colonies c
       LEFT JOIN sessions s ON s.colony_id = c.id
       LEFT JOIN accounts a ON a.active_colony_id = c.id
       WHERE s.colony_id IS NULL AND a.active_colony_id IS NULL AND c.status = 'active'
       LIMIT 1`,
    )
    .get() as { id: number } | undefined;
  return row?.id;
}

// Independent of seedIfEmpty()'s colonies-count gate: an already-deployed
// world has colonies > 0 (seedIfEmpty no-ops) but may still need its initial
// creature population. Called after seedIfEmpty() (and
// backfillWorldsCreaturesSeeded()) so a brand-new world's row already exists
// either way.
//
// Stage 12 fix: gated on the world's own durable `creatures_seeded` column,
// not a live species/table count. The original Stage 5/7 design used
// `COUNT(*) FROM creatures == 0` (then, for spiders specifically, a second
// independently-gated seedSpidersIfMissing() using
// `COUNT(*) FROM creatures WHERE species='spider' == 0`) — a live count that
// looks identical whether a world never had that species or legitimately
// hunted it to extinction, so a routine restart after a real in-game
// extinction would silently undo it by re-inserting the full original seed
// list. A one-time marker column fixes this: a world is seeded for its
// initial population at most once, ever, regardless of how its creature
// count fluctuates afterward. Once Stage 12's ecology takes over (see
// ecology.ts's advanceEcology()), it — not this boot-time function — is
// solely responsible for repopulating any species that later drops to zero.
// This also folds in what used to be the separate seedSpidersIfMissing()
// pass: every species in SPECIES_SEED_POSITIONS is seeded together, in one
// gated pass, exactly once per world.
function seedCreaturesIfEmpty(): void {
  const worlds = db.prepare("SELECT id FROM worlds WHERE creatures_seeded = 0").all() as { id: number }[];
  if (worlds.length === 0) return;
  const insertCreature = db.prepare(
    "INSERT INTO creatures (world_id, species, x, y, health, max_health) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const markSeeded = db.prepare("UPDATE worlds SET creatures_seeded = 1 WHERE id = ?");
  for (const world of worlds) {
    for (const [species, positions] of Object.entries(SPECIES_SEED_POSITIONS)) {
      const maxHealth = SPECIES_MAX_HEALTH[species];
      for (const pos of positions) {
        insertCreature.run(world.id, species, pos.x, pos.y, maxHealth, maxHealth);
      }
    }
    markSeeded.run(world.id);
  }
}

// Test-only seam (Stage 12): re-runs exactly the boot-time seed/migration
// calls a real process restart would run (see the module-level call
// sequence near the top of this file), against whatever state the DB is
// already in — no table wipe, unlike resetForTests() below. This is what
// lets a test simulate "the server restarts while an existing, already-
// initialized world happens to have zero spiders right now" without faking
// a fresh module import (ESM caches the module, so re-importing the same
// path doesn't re-run its top-level code — calling this instead reproduces
// the same idempotent effect a real restart has).
export function runBootSeedSequenceForTests(): void {
  seedIfEmpty();
  backfillWorldsCreaturesSeeded();
  seedCreaturesIfEmpty();
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
    DELETE FROM accounts;
  `);
  seedIfEmpty();
  seedCreaturesIfEmpty();
  backfillCreatureHealth();
  backfillWorkerHealth();
  backfillColonyLifecycle();
  backfillColonyEvolution();
  bootstrapAdminAccount();
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
//
// Stage 11: accounts themselves (usernames/password hashes/roles) are never
// wiped by a world reset — only the shared game world is destructive here,
// not player identity. accounts.active_colony_id is cleared to NULL in the
// same transaction so no account is left pointing at a colony id that no
// longer exists; the next request from an authenticated session simply
// claims/mints a fresh colony, exactly like a guest session whose sid cookie
// survived the reset (see getColonyForSession()/resolveIdentity()).
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
      UPDATE accounts SET active_colony_id = NULL;
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
    backfillColonyLifecycle();
    backfillColonyEvolution();
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
// Stage 8: `avoid` lets a caller (sessions.ts's Start New Colony path) keep a
// fresh spawn off every existing colony/ruin position and every live spider —
// a bounded retry over successive spiral indices, never an open-ended search
// (per the brief's "no full procedural world system"). Falls back to the
// plain spiral position for `index` if nothing clears within the bound, so
// colony creation can never fail outright over a crowded world.
const SPAWN_RETRY_ATTEMPTS = 20;

function pickSpawnPosition(index: number, avoid: { x: number; y: number; radius: number }[]): { x: number; y: number } {
  for (let attempt = 0; attempt < SPAWN_RETRY_ATTEMPTS; attempt++) {
    const candidate = colonySpiralPosition(index + attempt);
    const blocked = avoid.some((a) => Math.hypot(candidate.x - a.x, candidate.y - a.y) < a.radius);
    if (!blocked) return candidate;
  }
  return colonySpiralPosition(index);
}

export function createColony(avoid: { x: number; y: number; radius: number }[] = []): {
  colonyId: number;
  queenX: number;
  queenY: number;
  workers: { id: number; x: number; y: number; health: number; maxHealth: number; caste: Caste }[];
} {
  const world = db.prepare("SELECT id FROM worlds LIMIT 1").get() as { id: number } | undefined;
  if (!world) throw new Error("no world seeded");

  const { n: index } = db.prepare("SELECT COUNT(*) AS n FROM colonies").get() as { n: number };
  const { x: queenX, y: queenY } = pickSpawnPosition(index, avoid);

  let colonyId = 0;
  let workers: { id: number; x: number; y: number; health: number; maxHealth: number; caste: Caste }[] = [];
  const tx = db.transaction(() => {
    const colonyInfo = db
      .prepare(
        "INSERT INTO colonies (world_id, queen_x, queen_y, status, queen_health, queen_max_health, peak_population) VALUES (?, ?, ?, 'active', ?, ?, ?)",
      )
      .run(world.id, queenX, queenY, QUEEN_MAX_HEALTH, QUEEN_MAX_HEALTH, STARTING_WORKERS);
    colonyId = Number(colonyInfo.lastInsertRowid);

    seedColonyResources(colonyId);
    workers = spawnStartingWorkers(colonyId, queenX, queenY);
  });
  tx();

  return { colonyId, queenX, queenY, workers };
}

// Crit 10: resolves a session cookie value to the colony it owns, or
// undefined if the cookie is missing/stale (e.g. from a wiped test DB).
// Stage 8: this is the fresh-every-tick lookup broadcastState() uses — never
// cached per connection, so a session re-pointed mid-connection (Start New
// Colony) is picked up on the very next broadcast.
// Stage 11: extended for the account indirection. A guest session
// (account_id IS NULL) resolves exactly as before, straight from
// sessions.colony_id. An authenticated session resolves through a fresh
// accounts.active_colony_id lookup instead — never sessions.colony_id,
// which becomes vestigial the moment account_id is set — so login/logout/
// Reset Progress re-pointing an account's colony is picked up on the very
// next broadcast tick with zero WebSocket-side caching, the same Stage 8
// guarantee this function already gave guest sessions.
export function getColonyForSession(sessionId: string): number | undefined {
  const row = db.prepare("SELECT colony_id AS colonyId, account_id AS accountId FROM sessions WHERE id = ?").get(sessionId) as
    | { colonyId: number; accountId: number | null }
    | undefined;
  if (!row) return undefined;
  if (row.accountId == null) return row.colonyId;
  const account = getAccountById(row.accountId);
  return account?.activeColonyId ?? undefined;
}

// Stage 11: the raw, un-resolved session row — used by auth.ts's
// peekIdentity() to tell "guest session" from "authenticated session"
// before deciding which colony lookup applies. Deliberately separate from
// getColonyForSession() above, which already resolves the account
// indirection and is what every pre-Stage-11 call site still wants.
export function getSessionAccountId(sessionId: string): number | null | undefined {
  const row = db.prepare("SELECT account_id AS accountId FROM sessions WHERE id = ?").get(sessionId) as
    | { accountId: number | null }
    | undefined;
  return row?.accountId;
}

// Stage 11: points a session at an account (login/register), or clears that
// pointer back to NULL (logout) — never touches colony_id, which saveSession
// already manages independently. Requires the session row to already exist
// (callers call saveSession() first for a brand-new session id).
export function setSessionAccount(sessionId: string, accountId: number | null): void {
  db.prepare("UPDATE sessions SET account_id = ? WHERE id = ?").run(accountId, sessionId);
}

// Stage 8: an upsert, not a plain INSERT — Start New Colony re-points an
// existing session's single row to a fresh colony id (see sessions.ts). The
// old colony row is never deleted, so it persists unreferenced as a ruin;
// this is the entire "a session owns a sequence of colonies over time"
// design — one current colony per session, no separate history table.
export function saveSession(sessionId: string, colonyId: number): void {
  db.prepare("INSERT INTO sessions (id, colony_id) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET colony_id = excluded.colony_id").run(
    sessionId,
    colonyId,
  );
}

export interface AccountRow {
  id: number;
  username: string;
  passwordHash: string;
  passwordSalt: string;
  scryptN: number;
  scryptR: number;
  scryptP: number;
  role: string;
  activeColonyId: number | null;
}

const ACCOUNT_COLUMNS = `
  id, username,
  password_hash AS passwordHash, password_salt AS passwordSalt,
  scrypt_n AS scryptN, scrypt_r AS scryptR, scrypt_p AS scryptP,
  role, active_colony_id AS activeColonyId
`;

export function getAccountById(accountId: number): AccountRow | undefined {
  return db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`).get(accountId) as AccountRow | undefined;
}

// COLLATE NOCASE here matches the column's own declared collation, so this
// lookup is case-insensitive the same way the UNIQUE constraint is —
// "Alice" and "alice" resolve to the same row.
export function getAccountByUsername(username: string): AccountRow | undefined {
  return db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE username = ? COLLATE NOCASE`).get(username) as
    | AccountRow
    | undefined;
}

// Stage 11's account-side counterpart to saveSession(): re-points an
// account's single active_colony_id, the authoritative colony for every
// session with account_id set. Never deletes the old colony row — same
// "old colony persists as a ruin" discipline saveSession() already uses for
// guest sessions (see Start New Colony / Reset Progress).
export function setAccountColony(accountId: number, colonyId: number): void {
  db.prepare("UPDATE accounts SET active_colony_id = ? WHERE id = ?").run(colonyId, accountId);
}

export function createAccount(
  username: string,
  passwordHash: PasswordHash,
  role: "player" | "admin" = "player",
): number {
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO accounts (username, password_hash, password_salt, scrypt_n, scrypt_r, scrypt_p, role) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(username, passwordHash.hash, passwordHash.salt, passwordHash.params.n, passwordHash.params.r, passwordHash.params.p, role);
  return Number(lastInsertRowid);
}

// Stage 11 admin: the one place /api/admin/accounts reads from — explicit
// safe columns only (id, username, role, activeColonyId, createdAt), same
// never-SELECT-* discipline as ACCOUNT_COLUMNS, so password_hash/salt/scrypt
// params can never leak into an admin response by accident.
export interface AdminAccountRow {
  id: number;
  username: string;
  role: string;
  activeColonyId: number | null;
  createdAt: string;
}

export function getAllAccounts(): AdminAccountRow[] {
  return db
    .prepare(
      "SELECT id, username, role, active_colony_id AS activeColonyId, created_at AS createdAt FROM accounts ORDER BY id",
    )
    .all() as AdminAccountRow[];
}
