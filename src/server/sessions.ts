import { randomUUID } from "node:crypto";
import { COLONY_SPACING, QUEEN_MAX_HEALTH, SPIDER_CLEAR_RADIUS } from "./balance.ts";
import { createColony, db, getColonyForSession, getUnclaimedColonyId, saveSession } from "./db.ts";
import { isRuinExpired } from "./ecology.ts";
import { logAction } from "./log.ts";
import { getSpiderPositions, getWorkersForColony, isColonyActive, registerColony, registerWorker } from "./simulation.ts";

export const SESSION_COOKIE = "sid";

// No real cookie-parsing dependency needed — the only thing ever read from
// the cookie header is this one opaque token, never a password/account.
export function parseSessionId(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=");
  }
  return undefined;
}

// Stage 8: every existing colony's position — active *and* defeated — plus
// every live spider's current position, so a freshly minted colony never
// spawns on top of an active queen, an old ruin, or a wandering predator.
// Colonies get the larger COLONY_SPACING clearance (the same spacing
// successive colonies already keep from each other on the spiral); spiders
// get SPIDER_CLEAR_RADIUS, reusing the exact same "safe distance from a
// predator" constant Stage 7's nest-exclusion already uses. See
// createColony()'s `avoid` param in db.ts.
// Stage 12: an expired ruin stops avoiding — same isRuinExpired gate
// state.ts uses for visibility, so a new colony can spawn into space an
// expired ruin used to occupy the instant it disappears from the game view.
function buildSpawnAvoidance(): { x: number; y: number; radius: number }[] {
  const colonyRows = db.prepare("SELECT queen_x AS x, queen_y AS y, status, defeated_at AS defeatedAt FROM colonies").all() as {
    x: number;
    y: number;
    status: "active" | "defeated";
    defeatedAt: string | null;
  }[];
  const colonyPositions = colonyRows.filter((c) => c.status === "active" || !isRuinExpired(c.defeatedAt));
  return [
    ...colonyPositions.map((p) => ({ x: p.x, y: p.y, radius: COLONY_SPACING })),
    ...getSpiderPositions().map((p) => ({ ...p, radius: SPIDER_CLEAR_RADIUS })),
  ];
}

function mintColony(): number {
  const { colonyId, queenX, queenY, workers } = createColony(buildSpawnAvoidance());
  registerColony(colonyId, queenX, queenY, QUEEN_MAX_HEALTH, QUEEN_MAX_HEALTH, workers.length);
  for (const worker of workers)
    registerWorker({
      id: worker.id,
      colonyId,
      x: worker.x,
      y: worker.y,
      health: worker.health,
      maxHealth: worker.maxHealth,
      caste: worker.caste,
    });
  return colonyId;
}

// Stage 11: factored out of claimColonyForSession() so the account-based
// Reset Progress path (auth.ts) can claim/mint a colony and re-top-up the
// spare invariant exactly like a guest session does, without duplicating
// this logic or going through saveSession() (which would write the wrong
// table for an authenticated session — see setAccountColony() in db.ts).
// Callers are responsible for recording the claimed colonyId against
// whichever identity owns it (a session row or an account row).
//
// Always keeps one spare, unclaimed colony ready in the world. Without
// this, a session's own `colonies` roster (state.ts) could never include
// the colony the *next* claimant is about to claim — that colony simply
// wouldn't exist yet at the moment this request's response is serialized.
// Pre-minting it here means it's already a visible part of the shared world
// the instant this request returns, exactly like any other colony. See
// spec/multiplayer.test.ts's "shows both sessions the same shared world..."
// test and CLAUDE.md's Crit 10 section.
export function claimFreshColony(): { colonyId: number; claimedExisting: boolean } {
  let colonyId = getUnclaimedColonyId();
  const claimedExisting = colonyId !== undefined;
  if (colonyId === undefined) colonyId = mintColony();

  if (getUnclaimedColonyId() === undefined) mintColony();

  return { colonyId, claimedExisting };
}

// Shared by both resolveOrCreateColony (a session with no row yet) and
// startNewColony (Stage 8: a defeated session restarting) — claims whatever
// colony is currently sitting unclaimed, or mints a fresh one, saves the
// session's ownership of it immediately, then re-tops-up the spare
// invariant. Never mints two spares: the "ensure a spare exists" check runs
// once, after this session's own claim is already persisted.
//
// Deliberately NOT built on top of claimFreshColony() above: saveSession
// must happen *between* the claim and the spare top-up check, not before or
// after both — getUnclaimedColonyId() has no way to tell "claimed in memory
// a moment ago" from "still genuinely unclaimed" except by querying the
// `sessions` table itself; if this session's own claim isn't saved yet when
// that query runs, it sees its own about-to-be-claimed colony as the
// available spare and skips minting a real one — leaving the shared world
// with zero unclaimed colonies until the *next* session lazily mints its
// own, which is too late for *this* session's already-serialized response
// to ever have listed it. (A real regression caught by
// spec/multiplayer.test.ts's "shows both sessions the same shared world..."
// and otherWorkers-visibility tests.) The account-based Reset Progress path
// (auth.ts) has the exact same shape but writes accounts.active_colony_id
// via setAccountColony() instead of saveSession() — see claimFreshColony().
function claimColonyForSession(sessionId: string): { colonyId: number; claimedExisting: boolean } {
  let colonyId = getUnclaimedColonyId();
  const claimedExisting = colonyId !== undefined;
  if (colonyId === undefined) colonyId = mintColony();

  saveSession(sessionId, colonyId);

  if (getUnclaimedColonyId() === undefined) mintColony();

  return { colonyId, claimedExisting };
}

// Crit 10's core authorization seam: resolves the caller's own colony id from
// their session cookie, minting both a session and a colony on first contact.
// The client never supplies a colony id anywhere in this flow — ownership is
// derived entirely server-side, from a token the client can't forge its way
// into someone else's session for (a fresh random UUID per new session). See
// CLAUDE.md's Crit 10 section.
export function resolveOrCreateColony(cookieHeader: string | undefined): { sessionId: string; colonyId: number; isNew: boolean } {
  const existing = parseSessionId(cookieHeader);
  if (existing) {
    const colonyId = getColonyForSession(existing);
    if (colonyId !== undefined) return { sessionId: existing, colonyId, isNew: false };
  }

  const sessionId = randomUUID();

  // The very first session ever to arrive claims the pre-existing seeded
  // colony (continuity with the pre-Crit-10 single colony) instead of
  // minting a brand-new one on top of it — see getUnclaimedColonyId(). Every
  // later new session claims whatever colony is currently sitting unclaimed.
  const { colonyId, claimedExisting } = claimColonyForSession(sessionId);

  logAction(colonyId, claimedExisting ? "colony_claimed" : "colony_created", {
    workerCount: getWorkersForColony(colonyId).length,
  });

  return { sessionId, colonyId, isNew: true };
}

// Stage 8: the explicit, player-initiated "Start New Colony" action for a
// session whose current colony has just been defeated (by a spider or by
// their own abandonment — see actions.ts's abandon()). Eligibility is a
// valid session plus a defeated current colony — NOT resource balance, per
// §14 — so even a zero-worker, zero-protein session can always recover.
//
// saveSession is an upsert (see db.ts): this re-points the same session's
// single row to the new colony id. The session's identity (its `sid`
// cookie) never changes; only which colony it currently controls does. The
// old, defeated colony row is left exactly as-is — it's already a visible,
// non-controllable ruin the instant this returns (per §15's "no history
// table needed").
export function startNewColony(sessionId: string, currentColonyId: number): { ok: true; colonyId: number } | { ok: false; error: string } {
  if (isColonyActive(currentColonyId)) return { ok: false, error: "colony still active" };

  const { colonyId } = claimColonyForSession(sessionId);
  logAction(colonyId, "colony_started", { previousColonyId: currentColonyId });

  return { ok: true, colonyId };
}
