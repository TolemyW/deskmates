// Messages owned by every screen (shared formats, pills, dialogs) (issue #53): every key under these prefixes, in the
// five locales. Add keys with `node packages/web/scripts/i18n-add-keys.mjs`; see
// src/i18n/TRANSLATIONS.md.

import { defineMessages } from "../message-fragment.js";
import en from "./en.json";
import es from "./es.json";
import ja from "./ja.json";
import zhCN from "./zh-CN.json";
import zhTW from "./zh-TW.json";

export const commonMessages = defineMessages({
  owner: "i18n/common",
  prefixes: ["actor", "avatar", "dialog", "format", "markdown", "pager", "pill"],
  locales: { en, "zh-CN": zhCN, "zh-TW": zhTW, ja, es },
});
