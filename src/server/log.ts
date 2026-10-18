import { db } from "./db.ts";
import { type EvolutionChoice, traitDisplayName } from "./evolution.ts";

// Crit 10: durable "who did what" record, backing GET /api/log. Also prints
// a concise one-line stdout record of the same event — the thing an operator
// actually reads via `flyctl logs`, since nobody tails a SQLite table in
// production. Both happen on every call; neither is optional. See CLAUDE.md's
// Crit 10 section for why the log is keyed by colonyId rather than a player
// account (there are no accounts).
export function logAction(colonyId: number, action: string, detail?: Record<string, unknown>): void {
  db.prepare("INSERT INTO action_log (colony_id, action, detail) VALUES (?, ?, ?)").run(
    colonyId,
    action,
    detail ? JSON.stringify(detail) : null,
  );
  const suffix = detail ? ` ${JSON.stringify(detail)}` : "";
  console.log(`[action] colony=${colonyId} ${action}${suffix}`);
}

export interface LogEntry {
  id: number;
  createdAt: string;
  colonyId: number;
  action: string;
  detail: unknown;
}

export function getLog(): LogEntry[] {
  const rows = db
    .prepare("SELECT id, created_at AS createdAt, colony_id AS colonyId, action, detail FROM action_log ORDER BY id")
    .all() as { id: number; createdAt: string; colonyId: number; action: string; detail: string | null }[];
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    colonyId: row.colonyId,
    action: row.action,
    detail: row.detail ? JSON.parse(row.detail) : null,
  }));
}

// Stage 8: a small, public world-event feed — NOT chat, no free text, no
// session/cookie data. Derived directly from the existing action_log (§26
// prefers this over a new table) through a fixed set of safe message
// templates; never the raw `detail` JSON, which can carry worker/creature
// ids that are fine for GET /api/log but needless noise for a glanceable
// feed. Bounded + ordered newest-first, same shape every other bounded
// query in this codebase uses.
const WORLD_EVENT_ACTIONS = ["worker_died", "spider_died", "colony_defeated", "colony_started", "colony_evolved"];

export function getWorldEvents(limit = 6): { message: string }[] {
  const placeholders = WORLD_EVENT_ACTIONS.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT colony_id AS colonyId, action, detail FROM action_log WHERE action IN (${placeholders}) ORDER BY id DESC LIMIT ?`,
    )
    .all(...WORLD_EVENT_ACTIONS, limit) as { colonyId: number; action: string; detail: string | null }[];

  const messages: { message: string }[] = [];
  for (const row of rows) {
    const detail = row.detail ? (JSON.parse(row.detail) as Record<string, unknown>) : {};
    switch (row.action) {
      case "worker_died":
        if (detail.cause === "spider") messages.push({ message: `Colony ${row.colonyId} lost a worker to a spider.` });
        break;
      case "spider_died":
        messages.push({ message: "A spider was killed." });
        break;
      case "colony_defeated":
        messages.push({
          message:
            detail.cause === "abandoned"
              ? `Colony ${row.colonyId} was abandoned.`
              : `Colony ${row.colonyId} has fallen.`,
        });
        break;
      case "colony_started":
        messages.push({ message: "A new colony has emerged." });
        break;
      case "colony_evolved": {
        const tier = detail.tier as 1 | 2 | 3;
        const choice = detail.choice as EvolutionChoice;
        messages.push({ message: `Colony ${row.colonyId} evolved ${traitDisplayName(tier, choice)}.` });
        break;
      }
    }
  }
  return messages;
}
