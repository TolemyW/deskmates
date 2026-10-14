# Languages (issue #23)

The UI renders in English (the source), Simplified Chinese (`zh-CN`), Traditional Chinese
(`zh-TW`), Japanese (`ja`) and Spanish (`es`) with react-intl. Every word a person reads comes
from one flat ICU MessageFormat catalog per locale with the same keys, namespaced by the file
that uses them (`costs.title`, `chatPane.composer.placeholder`). The catalogs are assembled
(`src/i18n/catalogs.ts`) from message fragments: each owner (a feature in
`src/features/<feature>/messages/`, the shell in `src/app/messages/`, shared strings in
`src/i18n/common/`) keeps `<locale>.json` files for the key prefixes its `messages/index.ts`
lists, and `src/i18n/message-fragment-list.ts` registers every fragment. The
locale is the signed-in person's `locale` preference (`PATCH /auth/preferences`), then the first
browser language the UI has, then English; the Language control in the sidebar footer changes it
at once, and `<html lang>` follows it. Dates, numbers and units go through Intl in that locale
(`src/format.ts`).

Rules for new UI text:

- A component reads strings with `const t = useT()`: `t("key", { name })`, or `t.rich("key", {
  code: (chunks) => <code>{chunks}</code> })` for a message with tags. Code outside a component
  calls `currentI18n().t` when it runs; module constants hold keys (`MessageKey`), never words.
  Without a provider (a screen's own tests) the English catalog is used.
- Add keys with `node packages/web/scripts/i18n-add-keys.mjs <messages.json>`, which writes each
  key to the fragment that owns its prefix, with the English text in all five of that fragment's
  locale files, and keeps them sorted; then translate the four copies. A key whose prefix no
  fragment owns is refused.
  `src/i18n/catalogs.test.ts` fails on a missing key, invalid ICU or a translation whose
  arguments differ from English. A key a catalog lacks falls back to English, never to the key.
- `src/i18n/hard-coded-literals.test.ts` fails on a literal with letters in JSX text, a rendered
  JSX expression, `aria-label`/`placeholder`/`title`/`alt`, or a `confirm()` dialog. Proper
  nouns that are the same in every language go in `src/i18n/literal-allowlist.json`.
- Not translated: Gateway content (messages, names, task text, Gateway error messages, system
  messages in `thread_messages`), identifiers shown as code, and proper nouns.
- The four translations are machine-authored pending native review; `src/i18n/TRANSLATIONS.md`
  records their state and the terms used. `src/i18n/locale-render.test.tsx` renders Chats,
  Tasks, Approvals, Management and People in zh-CN and fails on English left on screen.
