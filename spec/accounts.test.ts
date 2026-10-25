import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");

// Stage 11: the entry-flow/account matrix (Continue as Guest, Register,
// Login, Logout, guest->account conversion, Reset Progress) over plain HTTP,
// following the exact persistent-cookie-jar convention spec/multiplayer.test.ts
// already established for Crit 10 — two sessions that share no cookies are
// simulated as two independent createSession() closures, and "same browser,
// later" is simulated by copying a session's own cookie string into a second
// closure (Recommendation 3 in the approved plan), never a real process
// restart or multi-browser tool.

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

async function getState(request: ReturnType<typeof createSession>) {
  const res = await request("/api/state");
  expect(res.status).toBe(200);
  return res.json();
}

function uniqueUsername(label: string) {
  return `${label}_${Math.random().toString(36).slice(2, 10)}`;
}

it("GET /api/session reports anonymous for a visitor with no cookie at all, and mints nothing", async () => {
  const res = await fetch(new URL("/api/session", baseUrl));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ status: "anonymous", username: null, role: null });
  // No cookie should have been minted just for asking.
  expect((res.headers as any).getSetCookie?.() ?? []).toEqual([]);
});

it("POST /api/auth/guest is idempotent: same session, asked twice, reports the same guest identity and colony", async () => {
  const alice = createSession();
  const res1 = await postJson(alice, "/api/auth/guest", {});
  expect(res1.status).toBe(200);
  const body1 = await res1.json();
  expect(body1.status).toBe("guest");
  expect(body1.username).toBeNull();

  const state1 = await getState(alice);

  const res2 = await postJson(alice, "/api/auth/guest", {});
  const body2 = await res2.json();
  expect(body2).toEqual(body1);

  const state2 = await getState(alice);
  expect(state2.colony.id).toBe(state1.colony.id);
});

it("GET /api/session reports guest, with no username, once a guest colony exists", async () => {
  const alice = createSession();
  await getState(alice); // mints the guest session/colony
  const res = await alice("/api/session");
  const body = await res.json();
  expect(body).toEqual({ status: "guest", username: null, role: null });
});

it("GET /api/state carries an identity field matching guest status", async () => {
  const alice = createSession();
  const state = await getState(alice);
  expect(state.identity).toEqual({ status: "guest", username: null, role: null });
});

it("rejects registration with invalid credentials (too-short username/password), without creating an account", async () => {
  const alice = createSession();
  await getState(alice);

  const shortUsername = await postJson(alice, "/api/auth/register", { username: "ab", password: "longenough1" });
  expect(shortUsername.status).toBe(400);

  const shortPassword = await postJson(alice, "/api/auth/register", { username: uniqueUsername("alice"), password: "short" });
  expect(shortPassword.status).toBe(400);

  const missing = await postJson(alice, "/api/auth/register", {});
  expect(missing.status).toBe(400);

  // Still just a guest — no account was created by any of these.
  const session = await (await alice("/api/session")).json();
  expect(session.status).toBe("guest");
});

it("rejects registering a username that's already taken, with a generic 409 and no account-detail leak", async () => {
  const username = uniqueUsername("taken");
  const first = createSession();
  await getState(first);
  const firstRes = await postJson(first, "/api/auth/register", { username, password: "correcthorsebattery" });
  expect(firstRes.status).toBe(200);

  const second = createSession();
  await getState(second);
  const secondRes = await postJson(second, "/api/auth/register", { username, password: "differentpassword1" });
  expect(secondRes.status).toBe(409);
  const body = await secondRes.json();
  expect(typeof body.error).toBe("string");
  expect(body.error.toLowerCase()).not.toContain(username.toLowerCase());
});

it("registering converts the existing guest colony into the new account's colony, rather than minting a fresh one", async () => {
  const alice = createSession();
  const guestState = await getState(alice);
  const guestColonyId = guestState.colony.id;
  const guestWorkerIds = guestState.workers.map((w: any) => w.id).sort();

  const username = uniqueUsername("convert");
  const res = await postJson(alice, "/api/auth/register", { username, password: "correcthorsebattery" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.username).toBe(username);
  expect(body.role).toBe("player");

  const afterState = await getState(alice);
  expect(afterState.colony.id).toBe(guestColonyId);
  expect(afterState.workers.map((w: any) => w.id).sort()).toEqual(guestWorkerIds);
  expect(afterState.identity).toEqual({ status: "account", username, role: "player" });

  const session = await (await alice("/api/session")).json();
  expect(session).toEqual({ status: "account", username, role: "player" });
});

it("rejects a second registration attempt on an already-logged-in session", async () => {
  const alice = createSession();
  await getState(alice);
  const username = uniqueUsername("already");
  const first = await postJson(alice, "/api/auth/register", { username, password: "correcthorsebattery" });
  expect(first.status).toBe(200);

  const second = await postJson(alice, "/api/auth/register", {
    username: uniqueUsername("another"),
    password: "correcthorsebattery",
  });
  expect(second.status).toBe(409);
});

it("rejects login with a wrong password, and separately with a nonexistent username, using the exact same generic message", async () => {
  const username = uniqueUsername("login");
  const owner = createSession();
  await getState(owner);
  const regRes = await postJson(owner, "/api/auth/register", { username, password: "correcthorsebattery" });
  expect(regRes.status).toBe(200);

  const wrongPassword = createSession();
  const wrongPasswordRes = await postJson(wrongPassword, "/api/auth/login", { username, password: "totallywrongpassword" });
  expect(wrongPasswordRes.status).toBe(401);
  const wrongPasswordBody = await wrongPasswordRes.json();

  const noSuchUser = createSession();
  const noSuchUserRes = await postJson(noSuchUser, "/api/auth/login", {
    username: uniqueUsername("doesnotexist"),
    password: "whatever12345",
  });
  expect(noSuchUserRes.status).toBe(401);
  const noSuchUserBody = await noSuchUserRes.json();

  expect(noSuchUserBody.error).toBe(wrongPasswordBody.error);
});

it("logs in successfully from a fresh browser session, lands on the account's existing colony, and preserves rather than merges the new session's own prior guest colony", async () => {
  const username = uniqueUsername("fullflow");
  const owner = createSession();
  const ownerState = await getState(owner);
  const ownerColonyId = ownerState.colony.id;
  const regRes = await postJson(owner, "/api/auth/register", { username, password: "correcthorsebattery" });
  expect(regRes.status).toBe(200);

  // A second, independent browser profile — already has its own guest colony
  // before it ever logs in.
  const visitor = createSession();
  const visitorGuestState = await getState(visitor);
  const visitorGuestColonyId = visitorGuestState.colony.id;
  expect(visitorGuestColonyId).not.toBe(ownerColonyId);

  const loginRes = await postJson(visitor, "/api/auth/login", { username, password: "correcthorsebattery" });
  expect(loginRes.status).toBe(200);
  const loginBody = await loginRes.json();
  expect(loginBody).toEqual({ username, role: "player" });

  const afterLogin = await getState(visitor);
  expect(afterLogin.colony.id).toBe(ownerColonyId);
  expect(afterLogin.identity).toEqual({ status: "account", username, role: "player" });

  // The visitor's own prior guest colony must still exist, untouched, as a
  // distinct entry in the shared roster — not deleted, not merged.
  const guestColonyStillThere = afterLogin.colonies.find((c: any) => c.id === visitorGuestColonyId);
  expect(guestColonyStillThere).toBeDefined();
  expect(guestColonyStillThere.status).toBe("active");
});

it("logout invalidates the session's account attachment but preserves the account and its colony", async () => {
  const username = uniqueUsername("logout");
  const session = createSession();
  const state = await getState(session);
  const colonyId = state.colony.id;
  const regRes = await postJson(session, "/api/auth/register", { username, password: "correcthorsebattery" });
  expect(regRes.status).toBe(200);

  const logoutRes = await postJson(session, "/api/auth/logout", {});
  expect(logoutRes.status).toBe(200);
  const logoutBody = await logoutRes.json();
  expect(logoutBody).toEqual({ ok: true });

  const sessionStatus = await (await session("/api/session")).json();
  expect(sessionStatus.status).not.toBe("account");

  // Logging back in reaches the exact same account/colony, proving neither
  // was deleted by logout.
  const relogRes = await postJson(session, "/api/auth/login", { username, password: "correcthorsebattery" });
  expect(relogRes.status).toBe(200);
  const afterRelogin = await getState(session);
  expect(afterRelogin.colony.id).toBe(colonyId);
});

it("rejects a logout attempt from a session that isn't logged in", async () => {
  const guest = createSession();
  await getState(guest);
  const res = await postJson(guest, "/api/auth/logout", {});
  expect(res.status).toBe(400);
});

it("rejects Reset Progress without the exact typed confirmation, for both a guest and a logged-in account", async () => {
  const guest = createSession();
  const guestState = await getState(guest);

  const noConfirm = await postJson(guest, "/api/account/reset-progress", {});
  expect(noConfirm.status).toBe(400);
  const wrongConfirm = await postJson(guest, "/api/account/reset-progress", { confirm: "reset" });
  expect(wrongConfirm.status).toBe(400);

  const afterRejected = await getState(guest);
  expect(afterRejected.colony.id).toBe(guestState.colony.id);
  expect(afterRejected.colony.status).toBe("active");
});

it("Reset Progress gives a guest session a fresh colony distinct from the old one, leaving the old colony as a defeated ruin with cause 'reset', and leaves other players untouched", async () => {
  const guest = createSession();
  const before = await getState(guest);
  const oldColonyId = before.colony.id;

  const bystander = createSession();
  const bystanderBefore = await getState(bystander);

  const res = await postJson(guest, "/api/account/reset-progress", { confirm: "RESET" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.colony.id).not.toBe(oldColonyId);
  expect(body.colony.status).toBe("active");
  expect(body.identity).toEqual({ status: "guest", username: null, role: null });

  const after = await getState(guest);
  expect(after.colony.id).toBe(body.colony.id);

  const oldRuin = after.colonies.find((c: any) => c.id === oldColonyId);
  expect(oldRuin).toBeDefined();
  expect(oldRuin.status).toBe("defeated");
  expect(oldRuin.defeatCause).toBe("reset");

  // The bystander's own colony is completely unaffected.
  const bystanderAfter = await getState(bystander);
  expect(bystanderAfter.colony.id).toBe(bystanderBefore.colony.id);
  expect(bystanderAfter.colony.status).toBe("active");
});

it("Reset Progress on a logged-in account re-points the account's active colony, not just the session's guest pointer", async () => {
  const username = uniqueUsername("resetacct");
  const session = createSession();
  const before = await getState(session);
  const oldColonyId = before.colony.id;
  const regRes = await postJson(session, "/api/auth/register", { username, password: "correcthorsebattery" });
  expect(regRes.status).toBe(200);

  const res = await postJson(session, "/api/account/reset-progress", { confirm: "RESET" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.colony.id).not.toBe(oldColonyId);
  expect(body.identity).toEqual({ status: "account", username, role: "player" });

  // Logging in again from a brand-new browser profile lands on the new
  // colony, proving the re-point lives on the account, not just this cookie.
  const elsewhere = createSession();
  const loginRes = await postJson(elsewhere, "/api/auth/login", { username, password: "correcthorsebattery" });
  expect(loginRes.status).toBe(200);
  const elsewhereState = await getState(elsewhere);
  expect(elsewhereState.colony.id).toBe(body.colony.id);

  const oldRuin = elsewhereState.colonies.find((c: any) => c.id === oldColonyId);
  expect(oldRuin).toMatchObject({ status: "defeated", defeatCause: "reset" });
});

it("an account registered from one browser profile is reachable, with its current colony, from a second browser profile that logs in with the same credentials (durability across 'devices')", async () => {
  const username = uniqueUsername("crossdevice");
  const deviceA = createSession();
  const stateA = await getState(deviceA);
  const colonyId = stateA.colony.id;
  const regRes = await postJson(deviceA, "/api/auth/register", { username, password: "correcthorsebattery" });
  expect(regRes.status).toBe(200);

  // A second "device": its own cookie jar, sharing nothing with deviceA.
  const deviceB = createSession();
  const loginRes = await postJson(deviceB, "/api/auth/login", { username, password: "correcthorsebattery" });
  expect(loginRes.status).toBe(200);
  const stateB = await getState(deviceB);
  expect(stateB.colony.id).toBe(colonyId);
  expect(stateB.identity).toEqual({ status: "account", username, role: "player" });
});

it("two independent guest sessions never collide on the same colony even across registration/reset churn (no double-claim of a colony)", async () => {
  const alice = createSession();
  const bob = createSession();
  await getState(alice);
  await getState(bob);

  const aliceReg = await postJson(alice, "/api/auth/register", { username: uniqueUsername("alice"), password: "correcthorsebattery" });
  expect(aliceReg.status).toBe(200);
  const bobReg = await postJson(bob, "/api/auth/register", { username: uniqueUsername("bob"), password: "correcthorsebattery" });
  expect(bobReg.status).toBe(200);

  const aliceState = await getState(alice);
  const bobState = await getState(bob);
  expect(aliceState.colony.id).not.toBe(bobState.colony.id);

  const aliceReset = await postJson(alice, "/api/account/reset-progress", { confirm: "RESET" });
  expect(aliceReset.status).toBe(200);
  const bobReset = await postJson(bob, "/api/account/reset-progress", { confirm: "RESET" });
  expect(bobReset.status).toBe(200);

  const aliceAfter = await getState(alice);
  const bobAfter = await getState(bob);
  expect(aliceAfter.colony.id).not.toBe(bobAfter.colony.id);
  expect(aliceAfter.colony.id).not.toBe(aliceState.colony.id);
  expect(bobAfter.colony.id).not.toBe(bobState.colony.id);
});
