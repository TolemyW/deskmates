// @vitest-environment node
// T0: the message catalogs are assembled from per-owner fragments (issue #53), so a feature's
// strings live next to the feature and adding one touches only that feature's files. This pins
// the layout: every fragment on disk is registered, every fragment has exactly the English keys
// in every locale, keys are sorted, each key's prefix belongs to its owner, no key or prefix is
// in two fragments, and the assembled catalogs hold exactly the fragments' messages.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { UI_LOCALES } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { CATALOGS, MESSAGE_FRAGMENTS } from "./catalogs.js";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** Every directory under src/ that holds locale fragment files. */
function fragmentDirectoriesOnDisk(): string[] {
  const found: string[] = [];
  const features = join(SRC, "features");
  if (existsSync(features))
    for (const entry of readdirSync(features, { withFileTypes: true }))
      if (entry.isDirectory() && existsSync(join(features, entry.name, "messages")))
        found.push(`features/${entry.name}/messages`);
  for (const fixed of ["app/messages", "i18n/common"])
    if (existsSync(join(SRC, fixed))) found.push(fixed);
  return found.sort();
}

function readFragmentFile(owner: string, locale: string): Record<string, string> {
  return JSON.parse(readFileSync(join(SRC, owner, `${locale}.json`), "utf8"));
}

describe("message fragments", () => {
  it("registers every fragment directory on disk, once, in sorted order", () => {
    const owners = MESSAGE_FRAGMENTS.map((fragment) => fragment.owner);
    expect(owners).toEqual([...owners].sort());
    expect(new Set(owners).size).toBe(owners.length);
    expect([...owners].sort()).toEqual(fragmentDirectoriesOnDisk());
  });

  it("lists the fragments one line per owner, sorted by path", () => {
    const list = readFileSync(join(SRC, "i18n/message-fragment-list.ts"), "utf8");
    const paths = [...list.matchAll(/^export \{ \w+ \} from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(paths.length).toBe(MESSAGE_FRAGMENTS.length);
    expect(paths).toEqual([...paths].sort());
  });

  it("gives each prefix to exactly one owner", () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const fragment of MESSAGE_FRAGMENTS)
      for (const prefix of fragment.prefixes) {
        const other = seen.get(prefix);
        if (other !== undefined) clashes.push(`${prefix}: ${other} and ${fragment.owner}`);
        seen.set(prefix, fragment.owner);
      }
    expect(clashes).toEqual([]);
  });

  it("keeps no key in two fragments", () => {
    const seen = new Map<string, string>();
    const twice: string[] = [];
    for (const fragment of MESSAGE_FRAGMENTS)
      for (const key of Object.keys(fragment.locales.en)) {
        const other = seen.get(key);
        if (other !== undefined) twice.push(`${key}: ${other} and ${fragment.owner}`);
        seen.set(key, fragment.owner);
      }
    expect(twice).toEqual([]);
  });

  for (const fragment of MESSAGE_FRAGMENTS) {
    describe(fragment.owner, () => {
      const englishKeys = Object.keys(fragment.locales.en).sort();

      it("has English messages and declares its prefixes", () => {
        expect(englishKeys.length).toBeGreaterThan(0);
        expect(fragment.prefixes.length).toBeGreaterThan(0);
      });

      it("uses only its own prefixes", () => {
        const prefixes = new Set(fragment.prefixes);
        expect(englishKeys.filter((key) => !prefixes.has(key.split(".")[0] ?? ""))).toEqual([]);
      });

      for (const locale of UI_LOCALES) {
        it(`${locale}: has exactly the English keys, sorted, as registered`, () => {
          const onDisk = readFragmentFile(fragment.owner, locale);
          const keys = Object.keys(onDisk);
          expect(keys, "keys in sorted order").toEqual(
            [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
          );
          expect([...keys].sort()).toEqual(englishKeys);
          expect(fragment.locales[locale]).toEqual(onDisk);
        });
      }
    });
  }

  for (const locale of UI_LOCALES) {
    it(`assembles ${locale} from exactly the fragments' messages`, () => {
      const union = Object.assign(
        {},
        ...MESSAGE_FRAGMENTS.map((fragment) => fragment.locales[locale]),
      ) as Record<string, string>;
      expect(CATALOGS[locale]).toEqual(union);
    });
  }
});
