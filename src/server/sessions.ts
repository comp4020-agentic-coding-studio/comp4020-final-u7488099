import { randomUUID } from "node:crypto";
import { createColony, getColonyForSession, getUnclaimedColonyId, saveSession } from "./db.ts";
import { logAction } from "./log.ts";
import { getWorkersForColony, registerColony, registerWorker } from "./simulation.ts";

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

function mintColony(): number {
  const { colonyId, queenX, queenY, workers } = createColony();
  registerColony(colonyId, queenX, queenY);
  for (const worker of workers) registerWorker({ id: worker.id, colonyId, x: worker.x, y: worker.y });
  return colonyId;
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
  let colonyId = getUnclaimedColonyId();
  const claimedExisting = colonyId !== undefined;
  if (colonyId === undefined) colonyId = mintColony();

  saveSession(sessionId, colonyId);
  logAction(colonyId, claimedExisting ? "colony_claimed" : "colony_created", {
    workerCount: getWorkersForColony(colonyId).length,
  });

  // Always keep one spare, unclaimed colony ready in the world. Without
  // this, a session's own `colonies` roster (state.ts) could never include
  // the colony the *next* session is about to claim — that colony simply
  // wouldn't exist yet at the moment this session's response is serialized.
  // Pre-minting it here means it's already a visible part of the shared
  // world the instant this request returns, exactly like any other colony.
  // See spec/multiplayer.test.ts's "shows both sessions the same shared
  // world..." test and CLAUDE.md's Crit 10 section.
  if (getUnclaimedColonyId() === undefined) mintColony();

  return { sessionId, colonyId, isNew: true };
}
