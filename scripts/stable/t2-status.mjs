// Packaging is immutable. A target host's latest receipt, not the manifest or an old
// passed marker, reports its T2 outcome; a failed full repeat must remain visible.
import { readFileSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function t2Status(releaseDirectory) {
  const version = basename(resolve(releaseDirectory));
  const receiptPath = join(releaseDirectory, ".release/t2.json");
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  } catch (error) {
    const reason = error.code === "ENOENT" ? "no receipt" : "unreadable or invalid receipt";
    return `t2       ${version}: unknown (${reason}; ${receiptPath})`;
  }
  if (
    receipt?.version !== version ||
    !["smoke", "full"].includes(receipt.scope) ||
    !Number.isInteger(receipt.exitCode) ||
    receipt.exitCode < 0
  )
    return `t2       ${version}: unknown (invalid receipt fields; ${receiptPath})`;
  const outcome = receipt.exitCode === 0 ? "passed" : "failed";
  return `t2       ${version}: ${outcome} (scope=${receipt.scope}, exitCode=${receipt.exitCode}; ${receiptPath}; counts and skips: .release/t2.log)`;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("usage: t2-status.mjs <release-directory>");
  console.log(t2Status(process.argv[2]));
}
