// Where a link or image in the bundled manual may lead (issue #28). The guide's Markdown is
// trusted repository text, but the renderer still treats every destination as untrusted: only
// manifest pages become internal navigation, only manifest assets load, and only http(s) leaves
// the app. Everything else renders as plain text.

import { type GuidePageId, isGuidePageId } from "./guide-manifest.js";

/** The public source repository; About and repository links point here. */
export const SOURCE_REPOSITORY = "https://github.com/TolemyW/deskmates";

export type GuideLink =
  | { kind: "topic"; page: GuidePageId; anchor?: string }
  | { kind: "external"; href: string }
  /** A repository file outside the guide, at the source the UI was built from. */
  | { kind: "repository"; href: string }
  | { kind: "blocked" };

const BLOCKED: GuideLink = { kind: "blocked" };

/** Characters a relative guide path may use; no escapes, queries, spaces or backslashes. */
const PATH_RE = /^[A-Za-z0-9._/-]+$/;
const ANCHOR_RE = /^[\p{L}\p{N}_-]+$/u;

/**
 * Normalize a relative path written in docs/guide/<from>.md to a path from the repository root.
 * Undefined when it is not a plain relative path or climbs out of the repository.
 */
function repositoryPath(path: string): string | undefined {
  if (!PATH_RE.test(path) || path.startsWith("/")) return undefined;
  const parts = ["docs", "guide"];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(segment);
  }
  return parts.length > 0 ? parts.join("/") : undefined;
}

export function resolveGuideLink(
  href: string,
  from: GuidePageId,
  options: { sourceRef: string },
): GuideLink {
  // A scheme is decided on the raw text: any whitespace or control character is refused rather
  // than trimmed, so "java\tscript:" cannot slip past as a relative path.
  if (href === "" || /[\s\p{Cc}]/u.test(href)) return BLOCKED;
  if (/^https?:\/\/[^/]/i.test(href)) return { kind: "external", href };
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href) || href.startsWith("//")) return BLOCKED;
  const hash = href.indexOf("#");
  const path = hash === -1 ? href : href.slice(0, hash);
  const anchor = hash === -1 ? undefined : href.slice(hash + 1);
  if (anchor !== undefined && !ANCHOR_RE.test(anchor)) return BLOCKED;
  if (path === "") return anchor ? { kind: "topic", page: from, anchor } : BLOCKED;
  const resolved = repositoryPath(path);
  if (!resolved) return BLOCKED;
  const guidePage = /^docs\/guide\/([^/]+)\.md$/.exec(resolved)?.[1];
  if (guidePage !== undefined) {
    if (!isGuidePageId(guidePage)) return BLOCKED;
    return anchor ? { kind: "topic", page: guidePage, anchor } : { kind: "topic", page: guidePage };
  }
  if (resolved.startsWith("docs/guide/")) return BLOCKED;
  const ref = encodeURIComponent(options.sourceRef);
  return {
    kind: "repository",
    href: `${SOURCE_REPOSITORY}/blob/${ref}/${resolved}${anchor ? `#${anchor}` : ""}`,
  };
}

/** The URL of a guide image, only when the manifest lists it. */
export function resolveGuideImage(
  src: string,
  assets: Readonly<Record<string, string>>,
): string | undefined {
  const name = src.startsWith("./") ? src.slice(2) : src;
  return Object.hasOwn(assets, name) ? assets[name] : undefined;
}

/** The text of a heading as GitHub anchors it: inline Markdown dropped, punctuation removed. */
export function slugify(heading: string): string {
  return heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
}

/** A slug function for one page: a repeated heading gets `-1`, `-2`, … as on GitHub. */
export function createSlugger(): (heading: string) => string {
  const seen = new Map<string, number>();
  return (heading) => {
    const base = slugify(heading);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
}
