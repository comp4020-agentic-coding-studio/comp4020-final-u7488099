#!/usr/bin/env node
// Stage 6b: the one intentionally-invoked, production-safe world reset. Run
// as `pnpm reset:world -- --yes` against whatever DB_PATH resolves to (the
// Fly volume in production, ./.data/colony.db locally) — never wired into
// boot, deploy, or any HTTP route. See db.ts's resetProductionWorld() and
// CLAUDE.md's Stage 6b section for exactly what this does and doesn't touch.
import { resetProductionWorld } from "../src/server/db.ts";
import { logAction } from "../src/server/log.ts";

function main(): void {
  if (!process.argv.includes("--yes")) {
    console.error(
      [
        "This permanently replaces every colony, worker, resource node, creature,",
        "and session with a freshly generated deterministic world. Existing player",
        "progress is NOT preserved. The action_log (GET /api/log history) IS",
        "preserved.",
        "",
        "Re-run with --yes to actually do it:",
        "  pnpm reset:world -- --yes",
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  const summary = resetProductionWorld();
  logAction(0, "world_reset", summary);
  console.log("World reset complete.");
  console.log(JSON.stringify(summary, null, 2));
}

main();
