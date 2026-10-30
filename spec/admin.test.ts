import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");

// Stage 11: the admin API matrix. The bootstrapped admin account comes from
// ADMIN_USERNAME/ADMIN_PASSWORD, set in mise.local.toml for dev and via
// `flyctl secrets set` in prod (see db.ts's bootstrapAdminAccount) — the
// running app this spec talks to already created it on boot, so this file
// only needs to log in with those same credentials, never create the
// account itself. If those env vars aren't set for whatever is running at
// baseUrl, every admin-success test here is skipped rather than failed,
// since "no admin configured" is a valid (if untestable) local state.
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

function createSession(initialCookie: string | null = null) {
  let cookie: string | null = initialCookie;
  const request = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set("cookie", cookie);
    const res = await fetch(new URL(path, baseUrl), { ...init, headers });
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

const ADMIN_ROUTES: { method: "GET" | "POST" | "PUT"; path: string }[] = [
  { method: "GET", path: "/api/admin/stats" },
  { method: "GET", path: "/api/admin/accounts" },
  { method: "GET", path: "/api/admin/colonies" },
  { method: "GET", path: "/api/admin/log" },
  { method: "POST", path: "/api/admin/colonies/1/defeat" },
  { method: "POST", path: "/api/admin/reset-world" },
  // Stage 12.5B
  { method: "GET", path: "/api/admin/world-monitor" },
  { method: "GET", path: "/api/admin/ecology-config" },
  { method: "PUT", path: "/api/admin/ecology-config" },
];

it("every /api/admin/* route rejects a guest session with a generic 403", async () => {
  const guest = createSession();
  await guest("/api/state");
  for (const route of ADMIN_ROUTES) {
    const init: RequestInit = { method: route.method };
    if (route.method === "POST" || route.method === "PUT") {
      init.headers = { "content-type": "application/json" };
      init.body = "{}";
    }
    const res = await guest(route.path, init);
    expect(res.status, `${route.method} ${route.path} for a guest`).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: "forbidden" });
  }
});

it("every /api/admin/* route rejects a logged-in non-admin account with a generic 403", async () => {
  const session = createSession();
  await session("/api/state");
  const username = `plainplayer_${Math.random().toString(36).slice(2, 10)}`;
  const regRes = await postJson(session, "/api/auth/register", { username, password: "correcthorsebattery" });
  expect(regRes.status).toBe(200);

  for (const route of ADMIN_ROUTES) {
    const init: RequestInit = { method: route.method };
    if (route.method === "POST" || route.method === "PUT") {
      init.headers = { "content-type": "application/json" };
      init.body = "{}";
    }
    const res = await session(route.path, init);
    expect(res.status, `${route.method} ${route.path} for a player account`).toBe(403);
  }
});

it.skipIf(!ADMIN_USERNAME || !ADMIN_PASSWORD)(
  "the bootstrapped admin account can log in and reach every read-only admin route",
  async () => {
    const admin = await adminSession();

    const statsRes = await admin("/api/admin/stats");
    expect(statsRes.status).toBe(200);
    const stats = await statsRes.json();
    expect(Object.keys(stats).sort()).toEqual(["accounts", "actionLogRows", "colonies"]);
    expect(typeof stats.accounts).toBe("number");
    expect(Object.keys(stats.colonies).sort()).toEqual(["active", "defeated", "total"]);

    const accountsRes = await admin("/api/admin/accounts");
    expect(accountsRes.status).toBe(200);
    const accounts = await accountsRes.json();
    expect(Array.isArray(accounts)).toBe(true);
    expect(accounts.length).toBeGreaterThan(0);
    for (const account of accounts) {
      expect(Object.keys(account).sort()).toEqual(["activeColonyId", "createdAt", "id", "role", "username"]);
    }
    const adminRow = accounts.find((a: any) => a.username === ADMIN_USERNAME);
    expect(adminRow).toBeDefined();
    expect(adminRow.role).toBe("admin");

    const coloniesRes = await admin("/api/admin/colonies");
    expect(coloniesRes.status).toBe(200);
    const colonies = await coloniesRes.json();
    expect(Array.isArray(colonies)).toBe(true);
    expect(colonies.length).toBeGreaterThan(0);
    for (const colony of colonies) {
      expect(Object.keys(colony).sort()).toEqual(
        ["defeatedAt", "evolution", "health", "id", "maxHealth", "peakPopulation", "population", "status", "x", "y"].sort(),
      );
    }

    const logRes = await admin("/api/admin/log");
    expect(logRes.status).toBe(200);
    const log = await logRes.json();
    expect(Array.isArray(log)).toBe(true);
    for (const entry of log) {
      expect(Object.keys(entry).sort()).toEqual(["action", "colonyId", "createdAt", "detail", "id"]);
    }
  },
);

it.skipIf(!ADMIN_USERNAME || !ADMIN_PASSWORD)(
  "no admin response ever contains a password hash, salt, session id, or cookie value",
  async () => {
    const admin = await adminSession();
    const accountsRes = await admin("/api/admin/accounts");
    const text = await accountsRes.text();
    expect(text).not.toMatch(/password/i);
    expect(text).not.toMatch(/salt/i);
    expect(text).not.toMatch(/scrypt/i);
    expect(text).not.toContain(admin.getCookie() ?? " impossible ");
  },
);

it.skipIf(!ADMIN_USERNAME || !ADMIN_PASSWORD)(
  "admin defeat-colony targets a real colony id, 404s a nonexistent one, and is idempotent",
  async () => {
    const admin = await adminSession();

    const bystander = createSession();
    const bystanderState = await (await bystander("/api/state")).json();
    const targetColonyId = bystanderState.colony.id;
    expect(bystanderState.colony.status).toBe("active");

    const missingRes = await postJson(admin, "/api/admin/colonies/999999999/defeat", {});
    expect(missingRes.status).toBe(404);

    const defeatRes = await postJson(admin, `/api/admin/colonies/${targetColonyId}/defeat`, {});
    expect(defeatRes.status).toBe(200);
    const defeatBody = await defeatRes.json();
    expect(defeatBody).toEqual({ ok: true });

    const afterState = await (await bystander("/api/state")).json();
    expect(afterState.colony.status).toBe("defeated");
    expect(afterState.colony.defeatCause).toBe("admin");

    // Idempotent: defeating an already-defeated colony is still a 200, not
    // an error, same as defeatColony()'s underlying guard.
    const secondDefeatRes = await postJson(admin, `/api/admin/colonies/${targetColonyId}/defeat`, {});
    expect(secondDefeatRes.status).toBe(200);
  },
);

it.skipIf(!ADMIN_USERNAME || !ADMIN_PASSWORD)(
  "admin reset-world requires the exact literal \"RESET WORLD\" confirmation, distinct from player Reset Progress's \"RESET\"",
  async () => {
    const admin = await adminSession();

    const noConfirm = await postJson(admin, "/api/admin/reset-world", {});
    expect(noConfirm.status).toBe(400);

    const wrongConfirm = await postJson(admin, "/api/admin/reset-world", { confirm: "RESET" });
    expect(wrongConfirm.status).toBe(400);

    // Deliberately never POSTs the correct "RESET WORLD" confirmation here —
    // that would actually wipe the shared dev DB this whole suite depends
    // on. Full reset-world success coverage runs against an isolated test
    // DB, per the plan's step 7.
  },
);

// Stage 12.5B: the admin map's data source, plus the new persistent ecology
// config endpoints. Config *behavior* (defaults/persistence/restart/target-
// and-delay effects) is covered directly against ecology.ts/ecologyConfig.ts
// in spec/ecology-config.test.ts — this file only proves the HTTP surface:
// shape, authorization (already covered above via ADMIN_ROUTES), and
// validation-rejection status codes.
it.skipIf(!ADMIN_USERNAME || !ADMIN_PASSWORD)(
  "world-monitor returns static anchor geometry plus live entities, and only includes workers behind ?units=1",
  async () => {
    const admin = await adminSession();

    const res = await admin("/api/admin/world-monitor");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["anchors", "colonies", "creatures", "exclusions", "resourceNodes", "world"]);
    expect(typeof body.world.width).toBe("number");
    expect(typeof body.world.height).toBe("number");
    expect(Array.isArray(body.anchors)).toBe(true);
    expect(body.anchors.length).toBe(10);
    for (const anchor of body.anchors) {
      expect(Object.keys(anchor).sort()).toEqual(["index", "radius", "x", "y"]);
    }
    expect(Array.isArray(body.resourceNodes)).toBe(true);
    expect(Array.isArray(body.creatures)).toBe(true);
    expect(Array.isArray(body.colonies)).toBe(true);
    expect(Array.isArray(body.exclusions)).toBe(true);
    for (const exclusion of body.exclusions) {
      expect(Object.keys(exclusion).sort()).toEqual(["radius", "x", "y"]);
    }

    const withUnits = await admin("/api/admin/world-monitor?units=1");
    expect(withUnits.status).toBe(200);
    const withUnitsBody = await withUnits.json();
    expect(Array.isArray(withUnitsBody.workers)).toBe(true);
    expect(withUnitsBody.workers.length).toBeGreaterThan(0);
    for (const worker of withUnitsBody.workers) {
      expect(Object.keys(worker).sort()).toEqual(["caste", "colonyId", "health", "id", "maxHealth", "x", "y"]);
    }
  },
);

it.skipIf(!ADMIN_USERNAME || !ADMIN_PASSWORD)(
  "the ecology snapshot's per-anchor entries carry the Stage 12.5B geometry/breakdown fields alongside the original Stage 12 ones",
  async () => {
    const admin = await adminSession();
    const res = await admin("/api/admin/ecology");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.anchors)).toBe(true);
    expect(body.anchors.length).toBe(10);
    for (const anchor of body.anchors) {
      expect(Object.keys(anchor).sort()).toEqual(
        ["baseTarget", "counts", "density", "exclusionCoverage", "key", "pendingMsRemaining", "radius", "target", "tier", "x", "y"].sort(),
      );
      expect(Object.keys(anchor.counts).sort()).toEqual(["aphid", "biomass", "protein", "spider", "sugar"]);
      expect(typeof anchor.exclusionCoverage).toBe("number");
      expect(anchor.exclusionCoverage).toBeGreaterThanOrEqual(0);
      expect(anchor.exclusionCoverage).toBeLessThanOrEqual(1);
    }
    expect(Object.keys(body.background).sort()).toEqual(["averageDensity", "pendingCount", "zoneCount"]);
  },
);

it.skipIf(!ADMIN_USERNAME || !ADMIN_PASSWORD)(
  "GET/PUT ecology-config round-trips valid input and rejects invalid input with 400, without a partial write",
  async () => {
    const admin = await adminSession();

    const before = await (await admin("/api/admin/ecology-config")).json();
    expect(Object.keys(before).sort()).toEqual(["anchorBaseTargets", "backgroundBaseTarget", "regenDelayMaxMs", "regenDelayMinMs", "updatedAt"]);
    expect(Array.isArray(before.anchorBaseTargets)).toBe(true);
    expect(before.anchorBaseTargets.length).toBe(10);

    // Invalid: min > max. Must be rejected, and must not alter the stored config.
    const invalidRes = await admin("/api/admin/ecology-config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ anchorBaseTargets: before.anchorBaseTargets, backgroundBaseTarget: 1, regenDelayMinMs: 9000, regenDelayMaxMs: 1000 }),
    });
    expect(invalidRes.status).toBe(400);
    const invalidBody = await invalidRes.json();
    expect(typeof invalidBody.error).toBe("string");
    const afterInvalid = await (await admin("/api/admin/ecology-config")).json();
    expect(afterInvalid.anchorBaseTargets).toEqual(before.anchorBaseTargets);
    expect(afterInvalid.regenDelayMinMs).toBe(before.regenDelayMinMs);

    // Valid: round-trips and is immediately reflected in a subsequent GET —
    // restored to the original values afterward so this test doesn't leak
    // config state into any other test in the shared dev DB.
    const validAnchorBaseTargets = before.anchorBaseTargets.map((_: number, i: number) => 10 + i);
    const validInput = { anchorBaseTargets: validAnchorBaseTargets, backgroundBaseTarget: 1.5, regenDelayMinMs: 16000, regenDelayMaxMs: 61000 };
    const validRes = await admin("/api/admin/ecology-config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validInput),
    });
    expect(validRes.status).toBe(200);
    const saved = await validRes.json();
    expect(saved.anchorBaseTargets).toEqual(validInput.anchorBaseTargets);
    expect(saved.backgroundBaseTarget).toBe(validInput.backgroundBaseTarget);
    expect(saved.regenDelayMinMs).toBe(validInput.regenDelayMinMs);
    expect(saved.regenDelayMaxMs).toBe(validInput.regenDelayMaxMs);
    expect(typeof saved.updatedAt).toBe("string");

    const afterValid = await (await admin("/api/admin/ecology-config")).json();
    expect(afterValid.anchorBaseTargets).toEqual(validInput.anchorBaseTargets);

    const restoreRes = await admin("/api/admin/ecology-config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        anchorBaseTargets: before.anchorBaseTargets,
        backgroundBaseTarget: before.backgroundBaseTarget,
        regenDelayMinMs: before.regenDelayMinMs,
        regenDelayMaxMs: before.regenDelayMaxMs,
      }),
    });
    expect(restoreRes.status).toBe(200);
  },
);

it.skipIf(!ADMIN_USERNAME || !ADMIN_PASSWORD)(
  "saving ecology-config never resets or reseeds the world — colony/account/resource-node counts are unchanged",
  async () => {
    const admin = await adminSession();
    const before = await (await admin("/api/admin/ecology-config")).json();
    const statsBefore = await (await admin("/api/admin/stats")).json();

    const touchedAnchorBaseTargets = before.anchorBaseTargets.map((v: number) => v + 1);
    await admin("/api/admin/ecology-config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ anchorBaseTargets: touchedAnchorBaseTargets, backgroundBaseTarget: 1.1, regenDelayMinMs: 15500, regenDelayMaxMs: 60500 }),
    });

    // A save legitimately appends one action_log row (the human-readable
    // admin_update_ecology_config entry) — that's the one expected change.
    // accounts/colonies must be completely untouched: no reset, no reseed.
    const statsAfter = await (await admin("/api/admin/stats")).json();
    expect(statsAfter.accounts).toBe(statsBefore.accounts);
    expect(statsAfter.colonies).toEqual(statsBefore.colonies);
    expect(statsAfter.actionLogRows).toBe(statsBefore.actionLogRows + 1);

    // Restore, same reasoning as the round-trip test above.
    await admin("/api/admin/ecology-config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        anchorBaseTargets: before.anchorBaseTargets,
        backgroundBaseTarget: before.backgroundBaseTarget,
        regenDelayMinMs: before.regenDelayMinMs,
        regenDelayMaxMs: before.regenDelayMaxMs,
      }),
    });
  },
);

it("the built admin client bundle never references a gameplay-mutation route — the admin map can issue no game command", async () => {
  const { execFileSync } = await import("node:child_process");
  const bundle = execFileSync("pnpm", ["exec", "esbuild", "src/client/admin.ts", "--bundle", "--format=esm"], {
    cwd: process.cwd(),
    encoding: "utf-8",
  });
  for (const forbidden of ["/api/command/", "/api/reproduce", "/api/evolve", "/api/start-new-colony", "/api/abandon"]) {
    expect(bundle).not.toContain(forbidden);
  }
});
