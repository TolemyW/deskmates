// What scripts/stable/release-main.sh tags: the next patch version after the highest release tag,
// and annotated-tag notes listing what landed on main since the previous one
// (docs/runbooks/stable-release.md). Kept apart from the shell script so it can be tested.
//
// CLI:
//   node scripts/stable/release-plan.mjs latest <tag>...         prints the highest vX.Y.Z, or
//                                                                 nothing when there is none
//   node scripts/stable/release-plan.mjs sorted <tag>...         prints every vX.Y.Z, highest first
//   node scripts/stable/release-plan.mjs next-version <tag>...   prints vX.Y.(Z+1) of the highest
//   git log --first-parent --format='%P%x1f%s%x1f%b%x1e' <prev>..<commit> |
//     node scripts/stable/release-plan.mjs notes <version>       prints the tag message

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SEMVER = /^v(\d+)\.(\d+)\.(\d+)$/;

/** Release tags among `tags`, highest first; anything that is not `vX.Y.Z` is ignored. */
export function releaseTags(tags) {
  return tags
    .map((t) => t.trim())
    .filter((t) => SEMVER.test(t))
    .sort((a, b) => {
      const [, a1, a2, a3] = SEMVER.exec(a).map(Number);
      const [, b1, b2, b3] = SEMVER.exec(b).map(Number);
      return b1 - a1 || b2 - a2 || b3 - a3;
    });
}

/** The patch after the highest release tag. */
export function nextPatch(tags) {
  const [highest] = releaseTags(tags);
  if (!highest) throw new Error("no vX.Y.Z tag to follow; tag the first release by hand");
  const [, major, minor, patch] = SEMVER.exec(highest).map(Number);
  return `v${major}.${minor}.${patch + 1}`;
}

/**
 * One line per first-parent commit, oldest first. A GitHub merge commit ("Merge pull request #N
 * from owner/branch", the pull request title in its body) becomes "- <title> (#N)"; any other
 * commit is its subject.
 */
export function releaseNotes(version, log) {
  const lines = [];
  for (const record of log.split("\x1e")) {
    const [parents = "", subject = "", body = ""] = record.replace(/^\n+/, "").split("\x1f");
    if (!subject.trim()) continue;
    const pr = /^Merge pull request #(\d+) from /.exec(subject);
    const title = body.trim().split("\n")[0]?.trim();
    if (pr && parents.trim().split(/\s+/).length > 1 && title) lines.push(`- ${title} (#${pr[1]})`);
    else lines.push(`- ${subject.trim()}`);
  }
  if (lines.length === 0) throw new Error("nothing landed since the previous release");
  return `Release ${version}\n\n${lines.reverse().join("\n")}\n`;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === "latest") {
    const [highest] = releaseTags(rest);
    return highest ? `${highest}\n` : "";
  }
  if (command === "sorted")
    return releaseTags(rest)
      .map((t) => `${t}\n`)
      .join("");
  if (command === "next-version") return `${nextPatch(rest)}\n`;
  if (command === "notes" && rest.length === 1)
    return releaseNotes(rest[0], readFileSync(0, "utf8"));
  throw new Error(
    "usage: release-plan.mjs latest <tag>... | sorted <tag>... | next-version <tag>... | notes <version> < git-log",
  );
}

const invoked = process.argv[1] && realpathSync(process.argv[1]);
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    process.stdout.write(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`release-plan: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
