import { defineConfig } from "vitest/config";
import { BaseSequencer } from "vitest/node";
import type { TestSpecification } from "vitest/node";

// Vitest's default sequencer orders files by cache/size heuristics, not by
// path, which is fine when test files are independent. They aren't here:
// every spec/*.test.ts mutates the one shared colony on the one running app,
// and colony.test.ts's first test asserts the pristine seed state, so it must
// always run before any file that mutates first. Plain alphabetical order
// used to get this right by coincidence, but Stage 11's accounts.test.ts and
// admin.test.ts sort before colony.test.ts/realtime.test.ts and, as an
// unavoidable part of exercising the guest/account/reset matrix, mint dozens
// of new active colonies each — scattered near enough to the original seed
// population's spiders that colony.test.ts's carcass test can lose its own
// gatherer to a stray spider, and realtime.test.ts's spider-visibility test
// can find its target standing inside some other new colony's nest-exclusion
// zone and never get aggroed at all. Both failures reproduce only when those
// two Stage 11 files run first; neither reproduces in isolation. So instead
// of pure path order, this sequencer uses an explicit priority list: the
// original (pre-Stage-11) file order is preserved exactly as-is, and the new
// colony-churning Stage 11 files are appended after it, once the spider-
// dependent tests are already done. auth.test.ts is a pure-function test
// with no DB access at all (see its own header comment) so its position
// doesn't matter; it's listed with the other new files for clarity. Any
// spec file not named here falls back to alphabetical order, appended after
// every named one.
const EXPLICIT_ORDER = [
  "colony.test.ts",
  "evolution.test.ts",
  "invariants.test.ts",
  "multiplayer.test.ts",
  "realtime.test.ts",
  "accounts.test.ts",
  "admin.test.ts",
  "auth.test.ts",
  "simulation.test.ts",
  "world.test.ts",
];

function priorityOf(moduleId: string): number {
  const name = moduleId.split("/").pop() ?? moduleId;
  const index = EXPLICIT_ORDER.indexOf(name);
  return index === -1 ? EXPLICIT_ORDER.length : index;
}

class PathOrderSequencer extends BaseSequencer {
  async sort(files: TestSpecification[]) {
    return [...files].sort((a, b) => {
      const priorityDiff = priorityOf(a.moduleId) - priorityOf(b.moduleId);
      if (priorityDiff !== 0) return priorityDiff;
      return a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0;
    });
  }
}

// Every test in spec/ runs against the running app, which spec/global-setup.ts
// finds. Only spec/ runs: a test anywhere else needs adding to `include`.
export default defineConfig({
  test: {
    include: ["spec/**/*.test.ts"],
    globalSetup: ["./spec/global-setup.ts"],
    // Every spec file mutates the same shared colony on the same running app —
    // there's no per-test isolation. Two files racing to gather/reproduce in
    // parallel workers would make both flaky, so files run one at a time.
    fileParallelism: false,
    sequence: { sequencer: PathOrderSequencer },
    // Stage 1c's gather is real travel over real wall-clock time (black-box
    // tests can't fast-forward the production timer loop) — the 5s default
    // isn't enough for a worker to walk to a resource and claim it.
    testTimeout: 30000,
  },
});
