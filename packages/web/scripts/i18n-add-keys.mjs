#!/usr/bin/env node
// Add English messages to the operator UI catalogs (issue #23) and keep the five locales in step:
// `node packages/web/scripts/i18n-add-keys.mjs <messages.json>`. The file is a flat
// `{ "screen.key": "English text" }` object. The catalogs are split into per-owner fragments
// (issue #53): each key goes to the fragment whose `messages/index.ts` lists the key's prefix
// (the part before the first dot) in `prefixes`, into en.json and, with the English text as a
// stand-in until it is translated, the other four locale files; keys stay sorted. Only the
// fragments that receive keys are written. A key whose prefix no fragment owns, or that already
// exists with a different English text, is refused. A lock directory lets several people (or
// agents) add keys at once without losing each other's.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const LOCALES = ["en", "zh-CN", "zh-TW", "ja", "es"];
const LOCK = join(SRC, "i18n", ".catalog-lock");

const input = process.argv[2];
if (!input) {
  console.error("usage: i18n-add-keys.mjs <messages.json>");
  process.exit(2);
}
const additions = JSON.parse(readFileSync(input, "utf8"));
for (const [key, value] of Object.entries(additions)) {
  if (typeof value !== "string" || value === "") throw new Error(`${key}: not a non-empty string`);
  if (!/^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9_-]+)+$/.test(key)) throw new Error(`${key}: bad key`);
}

/** Fragment directories under src/: features/<name>/messages, app/messages, i18n/common. */
function fragmentDirectories() {
  const dirs = [];
  const features = join(SRC, "features");
  if (existsSync(features))
    for (const entry of readdirSync(features, { withFileTypes: true }))
      if (entry.isDirectory() && existsSync(join(features, entry.name, "messages", "index.ts")))
        dirs.push(join("features", entry.name, "messages"));
  for (const fixed of [join("app", "messages"), join("i18n", "common")])
    if (existsSync(join(SRC, fixed, "index.ts"))) dirs.push(fixed);
  return dirs;
}

/** The `prefixes: [...]` string literals of a fragment's index.ts. */
function prefixesOf(dir) {
  const source = readFileSync(join(SRC, dir, "index.ts"), "utf8");
  const list = source.match(/prefixes:\s*\[([^\]]*)\]/);
  if (!list) throw new Error(`${dir}/index.ts: no prefixes list`);
  return [...list[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function lock() {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      mkdirSync(LOCK);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`could not take ${LOCK}; remove it if stale`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

const read = (dir, locale) => JSON.parse(readFileSync(join(SRC, dir, `${locale}.json`), "utf8"));
const write = (dir, locale, catalog) => {
  const sorted = Object.fromEntries(Object.entries(catalog).sort(([a], [b]) => (a < b ? -1 : 1)));
  writeFileSync(join(SRC, dir, `${locale}.json`), `${JSON.stringify(sorted, null, 2)}\n`);
};

const owners = new Map();
for (const dir of fragmentDirectories())
  for (const prefix of prefixesOf(dir)) {
    const other = owners.get(prefix);
    if (other) throw new Error(`prefix ${prefix} is in both ${other} and ${dir}`);
    owners.set(prefix, dir);
  }

const byFragment = new Map();
const unowned = [];
for (const [key, value] of Object.entries(additions)) {
  const dir = owners.get(key.split(".")[0]);
  if (!dir) {
    unowned.push(key);
    continue;
  }
  if (!byFragment.has(dir)) byFragment.set(dir, {});
  byFragment.get(dir)[key] = value;
}
if (unowned.length > 0) {
  for (const key of unowned)
    console.error(
      `${key}: no fragment owns the prefix "${key.split(".")[0]}"; add it to the prefixes of the owning messages/index.ts`,
    );
  process.exit(1);
}

lock();
try {
  const english = new Map([...byFragment.keys()].map((dir) => [dir, read(dir, "en")]));
  const clashes = [];
  for (const [dir, keys] of byFragment)
    for (const [key, value] of Object.entries(keys)) {
      const existing = english.get(dir)[key];
      if (existing !== undefined && existing !== value) clashes.push([key, existing, value]);
    }
  if (clashes.length > 0) {
    for (const [key, existing, value] of clashes)
      console.error(`${key}: exists as ${JSON.stringify(existing)}, not ${JSON.stringify(value)}`);
    process.exitCode = 1;
  } else {
    for (const [dir, keys] of byFragment) {
      let added = 0;
      for (const locale of LOCALES) {
        const catalog = locale === "en" ? english.get(dir) : read(dir, locale);
        for (const [key, value] of Object.entries(keys)) {
          if (key in catalog) continue;
          catalog[key] = value;
          if (locale === "en") added++;
        }
        write(dir, locale, catalog);
      }
      console.log(
        `${dir}: added ${added} key(s); en.json has ${Object.keys(english.get(dir)).length}`,
      );
    }
  }
} finally {
  rmdirSync(LOCK);
}
