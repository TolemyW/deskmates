// The one predicate for "which workspace image does this run use": a Docker image ID, never a
// tag. A tag is how a human finds an image and can be moved; the ID is what a run records and
// checks (docs/runbooks/image-tags-and-artifact-naming.md). Plain ESM so the `node`-run spike
// runners and shell scripts share it with the TypeScript suites (typed by image-id.d.mts).
//
// CLI: node acceptance/support/image-id.mjs <value> [what]
//   exits 0 silently when <value> is an image ID, else prints the error and exits 2.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** `sha256:` followed by exactly 64 lowercase hex digits, as `docker image inspect` prints it. */
export const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isImageId(value) {
  return typeof value === "string" && IMAGE_ID_PATTERN.test(value);
}

/**
 * Return `value` when it is a Docker image ID; throw otherwise, naming `what`.
 * @param {string | undefined} value
 * @param {string} what
 * @returns {string}
 */
export function requireImageId(value, what) {
  if (isImageId(value)) return value;
  throw new Error(
    `${what} must be pinned by Docker image ID (sha256:<64 hex>), got ${JSON.stringify(value)}`,
  );
}

/** @param {string | undefined} path */
function sameFile(path) {
  if (!path) return false;
  try {
    return realpathSync(path) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (sameFile(process.argv[1])) {
  const [value, what = "image"] = process.argv.slice(2);
  try {
    requireImageId(value, what);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
