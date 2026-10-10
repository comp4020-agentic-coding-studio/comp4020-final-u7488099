import { defineConfig } from "vitest/config";
import { BaseSequencer } from "vitest/node";
import type { TestSpecification } from "vitest/node";

// Vitest's default sequencer orders files by cache/size heuristics, not by
// path, which is fine when test files are independent. They aren't here:
// every spec/*.test.ts mutates the one shared colony on the one running app,
// and colony.test.ts's first test asserts the pristine seed state, so it must
// always run before any file that mutates first. Sorting by path keeps that
// deterministic regardless of cache state or file size.
class PathOrderSequencer extends BaseSequencer {
  async sort(files: TestSpecification[]) {
    return [...files].sort((a, b) => (a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0));
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
  },
});
