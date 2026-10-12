import { db } from "./db.ts";

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
