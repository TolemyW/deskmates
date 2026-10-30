// Messages owned by the analytics feature (issue #53): every key under these prefixes, in the
// five locales. Add keys with `node packages/web/scripts/i18n-add-keys.mjs`; see
// src/i18n/TRANSLATIONS.md. The navigation label is the shell's `app.nav.analytics`.

import { defineMessages } from "../../../i18n/message-fragment.js";
import en from "./en.json";
import es from "./es.json";
import ja from "./ja.json";
import zhCN from "./zh-CN.json";
import zhTW from "./zh-TW.json";

export const analyticsMessages = defineMessages({
  owner: "features/analytics/messages",
  prefixes: ["analytics"],
  locales: { en, "zh-CN": zhCN, "zh-TW": zhTW, ja, es },
});
