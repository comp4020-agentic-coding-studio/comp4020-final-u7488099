import {
  type AccountRow,
  createAccount,
  getAccountById,
  getAccountByUsername,
  getColonyForSession,
  getSessionAccountId,
  saveSession,
  setAccountColony,
  setSessionAccount,
} from "./db.ts";
import { logAction } from "./log.ts";
import { hashPassword, verifyPassword } from "./password.ts";
import { claimFreshColony, parseSessionId, resolveOrCreateColony } from "./sessions.ts";
import { defeatColony, isColonyActive } from "./simulation.ts";

export type Role = "player" | "admin";

// Stage 11's single resolution root for every /api route's authority,
// superseding resolveOrCreateColony as the thing request-handling middleware
// calls. Mints a guest session exactly as resolveOrCreateColony always has;
// the only new behaviour is reading through to the account row when one is
// attached. role/username/accountId are null for a guest session — never
// "player", which would misleadingly suggest an account exists.
export interface ResolvedIdentity {
  sessionId: string;
  colonyId: number;
  accountId: number | null;
  role: Role | null;
  username: string | null;
  isNew: boolean;
}

export function resolveIdentity(cookieHeader: string | undefined): ResolvedIdentity {
  const { sessionId, colonyId, isNew } = resolveOrCreateColony(cookieHeader);

  const accountId = getSessionAccountId(sessionId);
  if (!accountId) return { sessionId, colonyId, accountId: null, role: null, username: null, isNew };

  const account = getAccountById(accountId);
  if (!account) return { sessionId, colonyId, accountId: null, role: null, username: null, isNew };

  return {
    sessionId,
    colonyId,
    accountId: account.id,
    role: account.role as Role,
    username: account.username,
    isNew,
  };
}

// GET /api/session's non-minting counterpart to resolveIdentity() above — a
// visitor with no cookie at all must see "anonymous" and get no session/
// colony minted just for asking, so the entry gate can be shown before any
// game state exists. "guest" vs "account" mirrors the two session kinds
// sessions.account_id already distinguishes.
export interface SessionStatus {
  status: "anonymous" | "guest" | "account";
  username: string | null;
  role: Role | null;
}

export function peekIdentity(cookieHeader: string | undefined): SessionStatus {
  const sessionId = parseSessionId(cookieHeader);
  if (!sessionId) return { status: "anonymous", username: null, role: null };

  const colonyId = getColonyForSession(sessionId);
  if (colonyId === undefined) return { status: "anonymous", username: null, role: null };

  const accountId = getSessionAccountId(sessionId);
  if (!accountId) return { status: "guest", username: null, role: null };

  const account = getAccountById(accountId);
  if (!account) return { status: "guest", username: null, role: null };

  return { status: "account", username: account.username, role: account.role as Role };
}

const MIN_USERNAME_LENGTH = 3;
const MAX_USERNAME_LENGTH = 32;
const MIN_PASSWORD_LENGTH = 8;

function validateCredentials(username: unknown, password: unknown): string | null {
  if (typeof username !== "string" || typeof password !== "string") return "username and password are required";
  if (username.length < MIN_USERNAME_LENGTH || username.length > MAX_USERNAME_LENGTH)
    return `username must be ${MIN_USERNAME_LENGTH}-${MAX_USERNAME_LENGTH} characters`;
  if (password.length < MIN_PASSWORD_LENGTH) return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  return null;
}

export type AuthOutcome =
  | { ok: true; accountId: number; username: string; role: Role; colonyId: number }
  | { ok: false; status: number; error: string };

// Stage 11's guest->account conversion path: if this session already owns a
// guest colony, that colony becomes the new account's colony directly — no
// copy, no second colony, no merge logic, because ownership was never
// encoded on the colony row itself, only on whatever points at it (session
// or account). A session with no colony yet (shouldn't happen in practice,
// since resolveIdentity() always mints one first) falls back to minting one,
// so register() can never fail to leave the new account with a colony.
export function register(sessionId: string, username: unknown, password: unknown): AuthOutcome {
  const validationError = validateCredentials(username, password);
  if (validationError) return { ok: false, status: 400, error: validationError };
  const name = username as string;
  const pass = password as string;

  if (getSessionAccountId(sessionId)) return { ok: false, status: 409, error: "already logged in" };
  if (getAccountByUsername(name)) return { ok: false, status: 409, error: "username already taken" };

  const passwordHash = hashPassword(pass);
  const accountId = createAccount(name, passwordHash, "player");

  const colonyId = getColonyForSession(sessionId) ?? claimFreshColony().colonyId;
  setAccountColony(accountId, colonyId);
  setSessionAccount(sessionId, accountId);

  logAction(colonyId, "account_registered", { username: name }, accountId);

  return { ok: true, accountId, username: name, role: "player", colonyId };
}

// Never distinguishes "no such user" from "wrong password" — both return the
// exact same 401, so a failed login can't be used to enumerate usernames.
// Re-points only sessions.account_id; any guest colony this browser already
// had is left exactly as-is, orphaned but not deleted (Stage 11's "no
// guest->existing-account auto-merge" requirement).
export function login(sessionId: string, username: unknown, password: unknown): AuthOutcome {
  if (typeof username !== "string" || typeof password !== "string")
    return { ok: false, status: 400, error: "username and password are required" };

  const invalid = { ok: false, status: 401, error: "invalid username or password" } as const;

  const account = getAccountByUsername(username);
  if (!account) return invalid;

  const valid = verifyPassword(password, {
    hash: account.passwordHash,
    salt: account.passwordSalt,
    params: { n: account.scryptN, r: account.scryptR, p: account.scryptP },
  });
  if (!valid) return invalid;

  setSessionAccount(sessionId, account.id);

  // Every account should already have a colony from register()/reset, but a
  // fallback keeps login() total rather than leaving a would-be-impossible
  // null-colony account stuck.
  const colonyId = account.activeColonyId ?? claimFreshColony().colonyId;
  if (account.activeColonyId == null) setAccountColony(account.id, colonyId);

  logAction(colonyId, "account_login", { username: account.username }, account.id);

  return { ok: true, accountId: account.id, username: account.username, role: account.role as Role, colonyId };
}

export type LogoutOutcome = { ok: true } | { ok: false; status: number; error: string };

// Only clears sessions.account_id — never deletes the account, never deletes
// or touches any colony. The client is expected to treat a successful
// logout as "go back to the entry gate," not "resume the now-vestigial
// sessions.colony_id."
export function logout(sessionId: string): LogoutOutcome {
  const accountId = getSessionAccountId(sessionId);
  if (!accountId) return { ok: false, status: 400, error: "not logged in" };

  const colonyId = getColonyForSession(sessionId);
  const account = getAccountById(accountId);
  setSessionAccount(sessionId, null);

  if (colonyId !== undefined) {
    logAction(colonyId, "account_logout", account ? { username: account.username } : undefined, accountId);
  }

  return { ok: true };
}

export function accountRoleOf(account: AccountRow): Role {
  return account.role as Role;
}

export type ResetOutcome = { ok: true; colonyId: number } | { ok: false; status: number; error: string };

// Reuses the existing colony-defeat/claim pipeline rather than a parallel
// destructive path: the current colony is ended via defeatColony(..., "reset")
// — identical to abandonment except for the recorded cause — and a fresh one
// is claimed via claimFreshColony(), the same claim-or-mint primitive every
// other "this identity now owns a different colony" transition uses. A guest
// re-points via saveSession() (sessions.colony_id); an authenticated session
// re-points via setAccountColony() instead — never both — matching how each
// identity's authoritative colony is resolved elsewhere (getColonyForSession).
export function resetProgress(
  sessionId: string,
  accountId: number | null,
  currentColonyId: number,
  confirm: unknown,
): ResetOutcome {
  if (confirm !== "RESET") return { ok: false, status: 400, error: 'confirmation must be exactly "RESET"' };

  if (isColonyActive(currentColonyId)) defeatColony(currentColonyId, "reset");

  const { colonyId } = claimFreshColony();
  if (accountId != null) setAccountColony(accountId, colonyId);
  else saveSession(sessionId, colonyId);

  logAction(colonyId, "progress_reset", { previousColonyId: currentColonyId }, accountId ?? undefined);

  return { ok: true, colonyId };
}
