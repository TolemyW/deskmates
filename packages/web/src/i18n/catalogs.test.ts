// T0: the five message catalogs (issue #23, decision 1). English is the source; every other
// catalog has exactly its keys, every message is valid ICU MessageFormat, and a translation uses
// the same arguments and rich-text tags as the English message it translates.
import { UI_LOCALES } from "@deskmates/contracts";
import { type MessageFormatElement, TYPE, parse } from "@formatjs/icu-messageformat-parser";
import { describe, expect, it } from "vitest";
import { CATALOGS } from "./catalogs.js";

/** Argument names and tag names a message uses, e.g. `{count}` and `<code>`. */
function argumentsOf(elements: MessageFormatElement[], into = new Set<string>()): Set<string> {
  for (const element of elements) {
    if (element.type === TYPE.literal || element.type === TYPE.pound) continue;
    if (element.type === TYPE.tag) {
      into.add(`<${element.value}>`);
      argumentsOf(element.children, into);
      continue;
    }
    into.add(element.value);
    if (element.type === TYPE.plural || element.type === TYPE.select)
      for (const option of Object.values(element.options)) argumentsOf(option.value, into);
  }
  return into;
}

const english = CATALOGS.en;
const englishKeys = Object.keys(english).sort();
const INTERNAL_STATUS_CODE =
  /\b(?:waiting_approval(?:_live)?|waiting_browser|waiting_continuation|waiting_platform|thread_message|in_progress|allow_once|allow_always)\b/;

describe("message catalogs", () => {
  it("has a catalog for each of the five UI locales", () => {
    expect(Object.keys(CATALOGS).sort()).toEqual([...UI_LOCALES].sort());
    expect(englishKeys.length).toBeGreaterThan(0);
  });

  for (const locale of UI_LOCALES) {
    describe(locale, () => {
      const catalog: Record<string, string> = CATALOGS[locale];

      it("has exactly the English keys", () => {
        const keys = Object.keys(catalog).sort();
        expect(
          englishKeys.filter((key) => !(key in catalog)),
          "missing keys",
        ).toEqual([]);
        expect(
          keys.filter((key) => !(key in english)),
          "keys English does not have",
        ).toEqual([]);
      });

      it("has a non-empty, valid ICU message for every key", () => {
        const broken: string[] = [];
        for (const [key, message] of Object.entries(catalog)) {
          if (message.trim() === "") broken.push(`${key}: empty`);
          try {
            parse(message);
          } catch (err) {
            broken.push(`${key}: ${String(err)}`);
          }
        }
        expect(broken).toEqual([]);
      });

      it("does not expose internal status or event codes in user-facing copy", () => {
        const exposed = Object.entries(catalog)
          .filter(([, message]) => INTERNAL_STATUS_CODE.test(message))
          .map(([key, message]) => `${key}: ${message}`);
        expect(exposed).toEqual([]);
      });

      it("uses the arguments and tags of the English message", () => {
        const differing: string[] = [];
        for (const key of englishKeys) {
          const message = catalog[key];
          const source = english[key as keyof typeof english];
          if (message === undefined || source === undefined) continue;
          let mine: string[];
          let theirs: string[];
          try {
            mine = [...argumentsOf(parse(message))].sort();
            theirs = [...argumentsOf(parse(source))].sort();
          } catch {
            continue; // reported by the validity test
          }
          if (mine.join(",") !== theirs.join(","))
            differing.push(`${key}: ${mine.join(",")} vs ${theirs.join(",")}`);
        }
        expect(differing).toEqual([]);
      });
    });
  }
});
