import { pathToFileURL } from "node:url";
import { runCiTests } from "./test-metrics.mjs";
import { TEST_ROOTS } from "./test-scope.mjs";

export function guardTestPaths(value) {
  const guards = JSON.parse(value);
  if (
    !Array.isArray(guards) ||
    !guards.length ||
    guards.some(
      (path) =>
        typeof path !== "string" ||
        !TEST_ROOTS.test(path) ||
        !/^[\w./-]+$/.test(path) ||
        path.includes(".."),
    )
  )
    throw new Error("Invalid CI guard test paths");
  return guards;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = runCiTests(guardTestPaths(process.env.CI_GUARD_TESTS));
