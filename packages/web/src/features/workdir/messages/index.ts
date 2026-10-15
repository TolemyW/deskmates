// Messages owned by the working-directory feature (ADR-0036): every key under these prefixes, in
// the five locales. Add keys with `node packages/web/scripts/i18n-add-keys.mjs`; see
// src/i18n/TRANSLATIONS.md.

import { defineMessages } from "../../../i18n/message-fragment.js";
import en from "./en.json";
import es from "./es.json";
import ja from "./ja.json";
import zhCN from "./zh-CN.json";
import zhTW from "./zh-TW.json";

export const workdirMessages = defineMessages({
  owner: "features/workdir/messages",
  prefixes: ["workdir"],
  locales: { en, "zh-CN": zhCN, "zh-TW": zhTW, ja, es },
});
