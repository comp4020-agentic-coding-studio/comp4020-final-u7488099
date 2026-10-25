import Database from "better-sqlite3";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Stage 11 step 7: the one test file that actually POSTs the correct
// "RESET WORLD" confirmation and proves what it does to the database.
// spec/admin.test.ts deliberately never does this — it shares the one
// running app + dev DB the rest of the black-box suite depends on, and a
// real reset there would wipe every other spec file's state mid-run.
//
// This file instead spawns its OWN, fully separate `node src/server/index.ts`
// process, pointed at a throwaway DB_PATH and a different PORT, with its own
// ADMIN_USERNAME/ADMIN_PASSWORD so its bootstrapped admin account exists only
// in this isolated DB. index.ts has no app/server export and binds a real
// port unconditionally at module load (see its final `app.listen(...)`), so
// a same-process dynamic import (the world.test.ts/simulation.test.ts
// pattern) can't be used for the server itself — only a genuine child
// process can be started and killed without disturbing anything else.
//
// Every assertion that matters inspects the isolated SQLite file directly
// (a second, separate `better-sqlite3` handle opened read-only-in-spirit
// against the same DB_PATH) before and after the HTTP call, so this proves
// actual reset semantics, not just the HTTP response shape.
const DB_PATH = "./.data/colony.admin-reset-world-test.db";
const PORT = 8099;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ADMIN_USERNAME = "reset-test-admin";
const ADMIN_PASSWORD = "reset-test-admin-password-1";

function cleanupDbFiles(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(DB_PATH + suffix)) rmSync(DB_PATH + suffix);
  }
}

let serverProcess: ChildProcess;

async function waitForServer(): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/api/session`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (attempt >= 150) throw new Error(`isolated test server never came up at ${BASE_URL}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

beforeAll(async () => {
  cleanupDbFiles();
  serverProcess = spawn("node", ["src/server/index.ts"], {
    env: {
      ...process.env,
      DB_PATH,
      PORT: String(PORT),
      ADMIN_USERNAME,
      ADMIN_PASSWORD,
    },
    stdio: "pipe",
  });
  // If the server never comes up, surface its stderr instead of a bare timeout.
  let stderrBuffer = "";
  serverProcess.stderr?.on("data", (d) => {
    stderrBuffer += d.toString();
  });
  try {
    await waitForServer();
  } catch (err) {
    throw new Error(`${(err as Error).message}\n--- isolated server stderr ---\n${stderrBuffer}`);
  }
});

afterAll(async () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
    await new Promise((resolve) => serverProcess.once("exit", resolve));
  }
  cleanupDbFiles();
});

// A fresh read-only-in-spirit handle onto the same file the isolated server
// is writing (WAL mode — a second connection sees committed data without
// needing to be the same process). Opened and closed per call so it never
// holds the file open across the test file's lifetime and never races the
// server's own writes outside of a point where we've already awaited a
// response from it.
function inspectDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(DB_PATH);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function createSession() {
  let cookie: string | null = null;
  const request = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set("cookie", cookie);
    const res = await fetch(new URL(path, BASE_URL), { ...init, headers });
    const setCookie = (res.headers as any).getSetCookie?.() ?? [];
    for (const header of setCookie) {
      cookie = cookie ? `${cookie}; ${header.split(";")[0]}` : header.split(";")[0];
    }
    return res;
  };
  return Object.assign(request, { getCookie: () => cookie });
}

function postJson(request: ReturnType<typeof createSession>, path: string, body: unknown) {
  return request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function adminSession() {
  const session = createSession();
  await session("/api/state"); // mints a guest session/colony first
  const res = await postJson(session, "/api/auth/login", { username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  return session;
}

// A 403 rejection must perform no RESET-SPECIFIC mutation — but merely
// touching any /api/* route as a brand-new visitor legitimately mints a
// fresh guest session/colony via Crit 10's existing, unrelated minting
// middleware (which runs before requireAdmin ever gets a chance to reject
// the request). So "no mutation" here is verified the precise way: no
// accounts are ever created/altered by a 403, and above all no
// admin_reset_world action_log row is ever written — the one durable
// fingerprint an actual reset leaves behind. Raw colony-count-unchanged
// would be the wrong assertion (it can legitimately grow from ordinary
// minting) and would fail for a reason that has nothing to do with reset
// semantics.
function countResetLogRows(): number {
  return inspectDb(
    (db) => (db.prepare("SELECT COUNT(*) AS n FROM action_log WHERE action = 'admin_reset_world'").get() as { n: number }).n,
  );
}

describe("admin reset-world against an isolated test database (Stage 11 step 7)", () => {
  it("rejects a guest with 403 and performs no reset mutation", async () => {
    const accountsBefore = inspectDb((db) => (db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n);
    const resetLogBefore = countResetLogRows();

    const guest = createSession();
    await guest("/api/state");
    const res = await postJson(guest, "/api/admin/reset-world", { confirm: "RESET WORLD" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });

    expect(countResetLogRows()).toBe(resetLogBefore);
    expect(inspectDb((db) => (db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n)).toBe(
      accountsBefore,
    );
  });

  it("rejects an unauthenticated request (no session at all) with 403 and performs no reset mutation", async () => {
    const accountsBefore = inspectDb((db) => (db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n);
    const resetLogBefore = countResetLogRows();

    // Deliberately no prior /api/state call, so no cookie is ever sent.
    const res = await fetch(`${BASE_URL}/api/admin/reset-world`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "RESET WORLD" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });

    expect(countResetLogRows()).toBe(resetLogBefore);
    expect(inspectDb((db) => (db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n)).toBe(
      accountsBefore,
    );
  });

  it("rejects a logged-in non-admin account with 403 and performs no reset mutation", async () => {
    const session = createSession();
    await session("/api/state");
    const regRes = await postJson(session, "/api/auth/register", {
      username: `plainplayer_${Math.random().toString(36).slice(2, 10)}`,
      password: "correcthorsebattery",
    });
    expect(regRes.status).toBe(200);

    const colonyCountBefore = inspectDb((db) => (db.prepare("SELECT COUNT(*) AS n FROM colonies").get() as { n: number }).n);
    const resetLogBefore = countResetLogRows();

    const res = await postJson(session, "/api/admin/reset-world", { confirm: "RESET WORLD" });
    expect(res.status).toBe(403);

    // This session already exists, so unlike the two tests above, hitting
    // the admin route again mints nothing new — colony count really must be
    // frozen here.
    expect(inspectDb((db) => (db.prepare("SELECT COUNT(*) AS n FROM colonies").get() as { n: number }).n)).toBe(
      colonyCountBefore,
    );
    expect(countResetLogRows()).toBe(resetLogBefore);
  });

  it("rejects the admin's own request when confirmation is missing or wrong, with zero mutation", async () => {
    const admin = await adminSession();
    const before = inspectDb((db) => ({
      colonies: (db.prepare("SELECT COUNT(*) AS n FROM colonies").get() as { n: number }).n,
      sessions: (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n,
      actionLog: (db.prepare("SELECT COUNT(*) AS n FROM action_log").get() as { n: number }).n,
    }));

    const missing = await postJson(admin, "/api/admin/reset-world", {});
    expect(missing.status).toBe(400);

    // Distinct from player Reset Progress's "RESET" — must not be accepted here.
    const wrong = await postJson(admin, "/api/admin/reset-world", { confirm: "RESET" });
    expect(wrong.status).toBe(400);

    const lowercase = await postJson(admin, "/api/admin/reset-world", { confirm: "reset world" });
    expect(lowercase.status).toBe(400);

    const after = inspectDb((db) => ({
      colonies: (db.prepare("SELECT COUNT(*) AS n FROM colonies").get() as { n: number }).n,
      sessions: (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n,
      actionLog: (db.prepare("SELECT COUNT(*) AS n FROM action_log").get() as { n: number }).n,
    }));
    expect(after).toEqual(before);
  });

  it("the exact confirmation resets the gameplay world to clean seeded state, preserves accounts/action_log, and the admin survives and can still authenticate", async () => {
    const admin = await adminSession();

    // Dirty the world beyond the admin's own guest-mint: a second player
    // account with its own colony, plus some accumulated resources/sessions,
    // so the reset has something real to wipe.
    const playerSession = createSession();
    await playerSession("/api/state");
    const playerUsername = `player_${Math.random().toString(36).slice(2, 10)}`;
    const playerReg = await postJson(playerSession, "/api/auth/register", {
      username: playerUsername,
      password: "correcthorsebattery",
    });
    expect(playerReg.status).toBe(200);

    const guestOnly = createSession();
    await guestOnly("/api/state");

    const beforeState = inspectDb((db) => {
      const adminAccount = db.prepare("SELECT * FROM accounts WHERE username = ?").get(ADMIN_USERNAME) as any;
      const playerAccount = db.prepare("SELECT * FROM accounts WHERE username = ?").get(playerUsername) as any;
      return {
        colonies: (db.prepare("SELECT COUNT(*) AS n FROM colonies").get() as { n: number }).n,
        sessions: (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n,
        accounts: (db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n,
        actionLog: (db.prepare("SELECT COUNT(*) AS n FROM action_log").get() as { n: number }).n,
        adminAccount,
        playerAccount,
      };
    });
    expect(beforeState.colonies).toBeGreaterThanOrEqual(3); // admin, player, guestOnly at minimum
    expect(beforeState.sessions).toBeGreaterThanOrEqual(3);
    expect(beforeState.adminAccount).toBeTruthy();
    expect(beforeState.adminAccount.role).toBe("admin");
    expect(beforeState.playerAccount).toBeTruthy();

    const adminCookieBeforeReset = admin.getCookie();

    const res = await postJson(admin, "/api/admin/reset-world", { confirm: "RESET WORLD" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.colonies).toBe("number");
    expect(typeof body.workers).toBe("number");
    expect(typeof body.resourceNodes).toBe("number");
    expect(typeof body.creatures).toBe("number");
    expect(typeof body.sessionsCleared).toBe("number");
    expect(typeof body.actionLogPreservedRows).toBe("number");
    // Gameplay world returned to the clean seeded shape: exactly one colony,
    // matching the fresh-seed values world.test.ts's own reset test asserts.
    expect(body.colonies).toBe(1);

    const afterState = inspectDb((db) => {
      const adminAccount = db.prepare("SELECT * FROM accounts WHERE username = ?").get(ADMIN_USERNAME) as any;
      const playerAccount = db.prepare("SELECT * FROM accounts WHERE username = ?").get(playerUsername) as any;
      return {
        colonies: (db.prepare("SELECT COUNT(*) AS n FROM colonies").get() as { n: number }).n,
        workers: (db.prepare("SELECT COUNT(*) AS n FROM workers").get() as { n: number }).n,
        resourceNodes: (db.prepare("SELECT COUNT(*) AS n FROM resource_nodes").get() as { n: number }).n,
        creatures: (db.prepare("SELECT COUNT(*) AS n FROM creatures").get() as { n: number }).n,
        sessions: (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n,
        accounts: (db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n,
        actionLog: (db.prepare("SELECT COUNT(*) AS n FROM action_log").get() as { n: number }).n,
        adminAccount,
        playerAccount,
      };
    });

    // Accumulated colonies/units/resources/creatures are reset: back to the
    // single freshly-seeded colony and its workers/resources/creatures.
    expect(afterState.colonies).toBe(1);
    expect(afterState.workers).toBe(body.workers);
    expect(afterState.resourceNodes).toBe(body.resourceNodes);
    expect(afterState.creatures).toBe(body.creatures);
    expect(afterState.sessions).toBe(0); // every session, admin's own included, is cleared

    // Account/auth data that is supposed to survive a world reset actually
    // survives: both accounts (and their password hashes/salts/roles) are
    // byte-for-byte untouched, only active_colony_id is nulled.
    expect(afterState.accounts).toBe(beforeState.accounts);
    expect(afterState.adminAccount).toBeTruthy();
    expect(afterState.adminAccount.id).toBe(beforeState.adminAccount.id);
    expect(afterState.adminAccount.password_hash).toBe(beforeState.adminAccount.password_hash);
    expect(afterState.adminAccount.password_salt).toBe(beforeState.adminAccount.password_salt);
    expect(afterState.adminAccount.role).toBe("admin");
    expect(afterState.adminAccount.active_colony_id).toBeNull();
    expect(afterState.playerAccount).toBeTruthy();
    expect(afterState.playerAccount.id).toBe(beforeState.playerAccount.id);
    expect(afterState.playerAccount.password_hash).toBe(beforeState.playerAccount.password_hash);
    expect(afterState.playerAccount.active_colony_id).toBeNull();

    // Durable audit/log behaviour: action_log is preserved (not wiped), the
    // pre-reset rows (registrations etc.) are still there, plus exactly one
    // new admin_reset_world row attributing the action to the admin's own
    // account id with colony_id = 0 (the documented sentinel for "no
    // specific colony applies").
    expect(afterState.actionLog).toBe(beforeState.actionLog + 1);
    const resetLogRow = inspectDb(
      (db) =>
        db
          .prepare("SELECT * FROM action_log WHERE action = 'admin_reset_world' ORDER BY id DESC LIMIT 1")
          .get() as any,
    );
    expect(resetLogRow).toBeTruthy();
    expect(resetLogRow.colony_id).toBe(0);
    expect(resetLogRow.account_id).toBe(beforeState.adminAccount.id);
    // The route logs `result` itself (pre-`{ok:true, ...}` spread), so the
    // logged detail is the HTTP body minus the `ok` field it was spread onto.
    const { ok: _ok, ...resultOnly } = body;
    const loggedDetail = JSON.parse(resetLogRow.detail);
    expect(loggedDetail).toEqual(resultOnly);

    // Session/account security remains valid: the admin's pre-reset cookie
    // no longer resolves to anything (sessions table was wiped), so it must
    // be treated as a fresh/no-session request, never silently granted admin
    // again just because it's the same cookie value.
    const staleRes = await fetch(`${BASE_URL}/api/session`, {
      headers: adminCookieBeforeReset ? { cookie: adminCookieBeforeReset } : {},
    });
    expect(staleRes.status).toBe(200);
    const staleIdentity = await staleRes.json();
    expect(staleIdentity.status).not.toBe("account");

    // The admin account survives and can still authenticate: a brand-new
    // session, fresh login with the same credentials, succeeds and reports
    // role "admin" again.
    const reauth = createSession();
    await reauth("/api/state");
    const loginRes = await postJson(reauth, "/api/auth/login", { username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
    expect(loginRes.status).toBe(200);
    const loginBody = await loginRes.json();
    expect(loginBody.username).toBe(ADMIN_USERNAME);
    expect(loginBody.role).toBe("admin");

    // And the re-authenticated admin can reach admin routes again.
    const statsRes = await reauth("/api/admin/stats");
    expect(statsRes.status).toBe(200);
  });

  it("repeated resets are idempotent: no duplicate or corrupt seed state accumulates", async () => {
    const admin = await adminSession();

    const first = await postJson(admin, "/api/admin/reset-world", { confirm: "RESET WORLD" });
    expect(first.status).toBe(200);
    const firstBody = await first.json();

    // Re-authenticate (the reset just wiped every session, including the one
    // that was carrying the admin's own cookie).
    const admin2 = createSession();
    await admin2("/api/state");
    const relogin = await postJson(admin2, "/api/auth/login", { username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
    expect(relogin.status).toBe(200);

    const second = await postJson(admin2, "/api/admin/reset-world", { confirm: "RESET WORLD" });
    expect(second.status).toBe(200);
    const secondBody = await second.json();

    // Both resets land on exactly the same clean seeded shape — no
    // accumulation, no duplication, no drift between repeated resets.
    expect(secondBody.colonies).toBe(firstBody.colonies);
    expect(secondBody.workers).toBe(firstBody.workers);
    expect(secondBody.resourceNodes).toBe(firstBody.resourceNodes);
    expect(secondBody.creatures).toBe(firstBody.creatures);

    const finalCounts = inspectDb((db) => ({
      colonies: (db.prepare("SELECT COUNT(*) AS n FROM colonies").get() as { n: number }).n,
      workers: (db.prepare("SELECT COUNT(*) AS n FROM workers").get() as { n: number }).n,
      resourceNodes: (db.prepare("SELECT COUNT(*) AS n FROM resource_nodes").get() as { n: number }).n,
      creatures: (db.prepare("SELECT COUNT(*) AS n FROM creatures").get() as { n: number }).n,
      duplicateColonyAtOrigin: (
        db.prepare("SELECT COUNT(*) AS n FROM colonies WHERE queen_x = (SELECT queen_x FROM colonies LIMIT 1)").get() as {
          n: number;
        }
      ).n,
    }));
    expect(finalCounts.colonies).toBe(1);
    expect(finalCounts.workers).toBe(firstBody.workers);
    expect(finalCounts.resourceNodes).toBe(firstBody.resourceNodes);
    expect(finalCounts.creatures).toBe(firstBody.creatures);
    expect(finalCounts.duplicateColonyAtOrigin).toBe(1); // only the one colony exists at all
  });
});
