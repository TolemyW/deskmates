// The message catalogs (issue #23, decision 1): ICU MessageFormat, English the source. Each owner
// (a feature, the app shell, the shared `common` set) keeps its keys in its own `messages/`
// fragment (issue #53); this file assembles the five catalogs from `message-fragment-list.ts`.
// `MessageKey` is the union of every fragment's English keys, so a screen naming a key English
// lacks fails to compile. Every other catalog has the same keys (`catalogs.test.ts`), and
// `message-fragments.test.ts` pins the layout.

import { UI_LOCALES, type UiLocale } from "@deskmates/contracts";
import * as FRAGMENTS from "./message-fragment-list.js";
import type { MessageFragment } from "./message-fragment.js";

type RegisteredFragment = (typeof FRAGMENTS)[keyof typeof FRAGMENTS];

/** Every registered fragment, sorted by its directory under `src/`. */
export const MESSAGE_FRAGMENTS: readonly RegisteredFragment[] = Object.values(FRAGMENTS).sort(
  (a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0),
);

type EnglishKeysOf<F> = F extends MessageFragment<infer E> ? keyof E & string : never;

export type MessageKey = EnglishKeysOf<RegisteredFragment>;

export type Catalog = Readonly<Record<string, string>>;

function assemble(locale: UiLocale): Catalog {
  const catalog: Record<string, string> = {};
  for (const fragment of MESSAGE_FRAGMENTS) Object.assign(catalog, fragment.locales[locale]);
  return catalog;
}

export const CATALOGS: Readonly<Record<UiLocale, Catalog>> = Object.fromEntries(
  UI_LOCALES.map((locale) => [locale, assemble(locale)]),
) as Record<UiLocale, Catalog>;

// The English fragments together hold exactly the MessageKey union, so the cast is only a
// widening TypeScript cannot follow through Object.assign.
export const ENGLISH = CATALOGS.en as Readonly<Record<MessageKey, string>>;
