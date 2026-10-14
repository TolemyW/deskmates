// Content-addressed tags for the runtime images (docs/runbooks/image-tags-and-artifact-naming.md):
// `deskmates/<name>:<arch>-<hash12>`, where hash12 covers exactly the files the image's build reads.
// One implementation for the build scripts, the release scripts and humans, so that all three
// derive the same name from one tree.
//
// CLI: node scripts/image-tag.mjs base|workspace|egress|connector-postgres [--arch amd64|arm64] [--hash-only]
//   prints the tag (or the 12-hex hash) for the current tree. Run it after
//   `npm run build -w packages/contracts -w packages/sidecar`: the workspace hash covers their dist/.
// node scripts/image-tag.mjs <kind> --source-inputs
//   prints the checked-in roots that kind depends on (sourceInputs below), one per line; no build
//   needed.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const IMAGE_REPOS = {
  base: "deskmates/workspace-base",
  workspace: "deskmates/workspace",
  egress: "deskmates/egress-proxy",
  "connector-postgres": "deskmates/connector-postgres",
};

// The root .dockerignore admits these for images/workspace/Dockerfile; images/workspace-base and
// images/egress copy only from their own directories. `.dockerignore` itself is an input because it decides
// what reaches the build context.
const INPUTS = {
  workspace: [
    ".dockerignore",
    "images/workspace",
    "packages/contracts/package.json",
    "packages/contracts/dist",
    "packages/gateway/starter-skills",
    "packages/sidecar/package.json",
    "packages/sidecar/dist",
  ],
  base: ["images/workspace-base"],
  egress: ["images/egress"],
  // images/connector-postgres/Dockerfile.dockerignore admits these; the other workspaces'
  // package.json files are copied only so npm ci sees the lockfile in sync.
  "connector-postgres": [
    "images/connector-postgres",
    "package.json",
    "package-lock.json",
    "packages/channels/package.json",
    "packages/channels/deskmates-agent-mcp/package.json",
    "packages/connector-postgres/package.json",
    "packages/connector-postgres/dist",
    "packages/connector-postgres/migrations",
    "packages/contracts/package.json",
    "packages/contracts/dist",
    "packages/gateway/package.json",
    "packages/golden-site/package.json",
    "packages/sandbox-docker/package.json",
    "packages/sidecar/package.json",
    "packages/testkit/package.json",
    "packages/web/package.json",
  ],
};

// The image a kind is built FROM, whose inputs are therefore also this kind's.
const FROM = { workspace: "base" };

// What compiles a `packages/<name>/dist` input besides that package's own sources: the root
// toolchain, and for the workspace testkit, which `tsc -b` builds before the sidecar whose tests
// import it (.github/workflows/release.yml).
const DIST_TOOLCHAIN = {
  workspace: ["package.json", "package-lock.json", "tsconfig.base.json", "packages/testkit"],
};

/**
 * Sorted repo-relative roots of every checked-in file an image of this kind depends on: its
 * inputs, with a built `packages/<name>/dist` (or that package's package.json) replaced by
 * `packages/<name>`, plus the toolchain that builds it and the inputs of the image it is FROM.
 * The release workflow compares these between two commits to tell whether the image would build
 * the same; one list here keeps that comparison in step with the hash.
 */
export function sourceInputs(kind) {
  if (!INPUTS[kind]) throw new Error(`unknown image kind ${JSON.stringify(kind)}`);
  const roots = new Set();
  let built = false;
  for (const input of INPUTS[kind]) {
    const pkg = /^(packages\/[^/]+)\/(dist|package\.json)$/.exec(input);
    if (pkg?.[2] === "dist") built = true;
    roots.add(pkg ? pkg[1] : input);
  }
  if (built) for (const input of DIST_TOOLCHAIN[kind] ?? []) roots.add(input);
  if (FROM[kind]) for (const input of sourceInputs(FROM[kind])) roots.add(input);
  return [...roots].sort();
}

// Mirrors the exclusions in the root .dockerignore.
const EXCLUDED = [
  /(^|\/)node_modules(\/|$)/,
  /\.tsbuildinfo$/,
  /\.map$/,
  /\.test\.js$/,
  /\.test\.d\.ts$/,
];

// Per-kind exclusions on top of EXCLUDED, mirroring that image's own dockerignore.
const EXTRA_EXCLUDED = {
  "connector-postgres": [/(^|\/)test-support(\/|$)/],
};

/** Sorted repo-relative paths of every file the image's build reads. */
export function imageInputs(root, kind) {
  const roots = INPUTS[kind];
  if (!roots)
    throw new Error(
      `unknown image kind ${JSON.stringify(kind)}; use base, workspace, egress or connector-postgres`,
    );
  const excluded = [...EXCLUDED, ...(EXTRA_EXCLUDED[kind] ?? [])];
  const files = [];
  const walk = (path) => {
    const rel = relative(root, path).split(sep).join("/");
    if (excluded.some((re) => re.test(rel))) return;
    const st = statSync(path);
    if (st.isDirectory()) {
      for (const entry of readdirSync(path)) walk(join(path, entry));
    } else if (st.isFile()) {
      files.push(rel);
    }
  };
  for (const input of roots) {
    const path = join(root, input);
    try {
      statSync(path);
    } catch {
      throw new Error(`${input} is missing; build contracts and sidecar first`);
    }
    walk(path);
  }
  return files.sort();
}

/** First 12 hex characters of a SHA-256 over (path, executable bit, content hash) per input. */
export function inputHash(root, kind) {
  const outer = createHash("sha256");
  // The workspace image is FROM the base, so a new base is a new workspace image.
  if (kind === "workspace")
    outer.update(`FROM deskmates/workspace-base\0${inputHash(root, "base")}\n`);
  for (const rel of imageInputs(root, kind)) {
    const path = join(root, rel);
    const exec = (statSync(path).mode & 0o111) !== 0 ? "x" : "-";
    const content = createHash("sha256").update(readFileSync(path)).digest("hex");
    outer.update(`${rel}\0${exec}\0${content}\n`);
  }
  return outer.digest("hex").slice(0, 12);
}

export function normalizeArch(arch) {
  const map = { x64: "amd64", x86_64: "amd64", amd64: "amd64", arm64: "arm64", aarch64: "arm64" };
  const out = map[arch];
  if (!out) throw new Error(`unsupported architecture ${JSON.stringify(arch)}`);
  return out;
}

/** The Docker daemon's architecture: a colima VM on an arm64 Mac builds arm64 images. */
export function daemonArch() {
  try {
    const out = execFileSync("docker", ["version", "--format", "{{.Server.Arch}}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return normalizeArch(out.trim());
  } catch {
    return normalizeArch(process.arch);
  }
}

export function imageTag(kind, arch, hash) {
  return `${IMAGE_REPOS[kind]}:${normalizeArch(arch)}-${hash}`;
}

function main(argv) {
  const kind = argv[0];
  let arch;
  let hashOnly = false;
  let sources = false;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--arch") arch = argv[++i];
    else if (argv[i] === "--hash-only") hashOnly = true;
    else if (argv[i] === "--source-inputs") sources = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (sources) {
    process.stdout.write(`${sourceInputs(kind).join("\n")}\n`);
    return;
  }
  const root = fileURLToPath(new URL("..", import.meta.url));
  const hash = inputHash(root, kind);
  process.stdout.write(`${hashOnly ? hash : imageTag(kind, arch ?? daemonArch(), hash)}\n`);
}

const invoked = process.argv[1] && realpathSync(process.argv[1]);
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`image-tag: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
