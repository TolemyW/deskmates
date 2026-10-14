// One owner's share of the message catalogs (issue #53): the keys under the prefixes it owns, in
// all five locales. `catalogs.ts` assembles the catalogs from the sorted list of fragments.

import type { UiLocale } from "@deskmates/contracts";

export type EnglishMessages = Readonly<Record<string, string>>;

export interface MessageFragment<E extends EnglishMessages = EnglishMessages> {
  /** The fragment's directory relative to `src/`, e.g. `features/chats/messages`. */
  readonly owner: string;
  /** The first key segments this owner holds; no other fragment may use them. */
  readonly prefixes: readonly string[];
  /** English is the source; every other locale has exactly its keys. */
  readonly locales: { readonly en: E } & {
    readonly [L in Exclude<UiLocale, "en">]: Readonly<Record<NoInfer<keyof E>, string>>;
  };
}

/** Types a fragment so a locale missing an English key fails to compile. */
export function defineMessages<E extends EnglishMessages>(
  fragment: MessageFragment<E>,
): MessageFragment<E> {
  return fragment;
}
