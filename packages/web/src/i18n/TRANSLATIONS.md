# Operator UI translations

The operator UI's message catalogs (issue #23). English (`en.json`) is the source catalog, written
with the code. The other four were written by the implementing agent on 2026-10-09, translated
from the English text and the screens that use each key. **None has been reviewed by a native
speaker yet.** Treat every one as machine-authored until a reviewer signs it off here.

The English and Simplified Chinese operational copy was rewritten against the owner-approved
product vocabulary on 2026-10-19. That rewrite is implementation work, not linguistic sign-off:
`zh-CN` is still machine-authored and still requires an independent native-speaker review on the
running UI. Do not describe it as reviewed until a named reviewer adds a Sign-off row below.

| Locale | File | Author | Review state |
|---|---|---|---|
| English | `en.json` | Source text, written with the code | Source |
| Simplified Chinese | `zh-CN.json` | Machine-authored (implementing agent), 2026-10-09 | Pending native review |
| Traditional Chinese (Taiwan) | `zh-TW.json` | Machine-authored (implementing agent), 2026-10-09 | Pending native review |
| Japanese | `ja.json` | Machine-authored (implementing agent), 2026-10-09 | Pending native review |
| Spanish | `es.json` | Machine-authored (implementing agent), 2026-10-09 | Pending native review |

## Where the files are

Since 2026-10-13 (issue #53) each catalog is split by owner so that work on one feature touches
only that feature's files. A key's owner is its prefix, the part before the first dot
(`tasks.roleNote` belongs to `tasks`). Each owner has a directory holding the five locale files
above, each with exactly the English keys in sorted order, and an `index.ts` that names the
prefixes it owns:

| Owner | Directory under `packages/web/src/` | Prefixes |
|---|---|---|
| A feature | `features/<feature>/messages/` | the feature's screens, e.g. `tasks` or `costs`, `costAlerts` |
| App shell | `app/messages/` | `app`, `firstRunChecklist`, `manual`, `panel`, `roles` |
| Shared | `i18n/common/` | `actor`, `avatar`, `dialog`, `format`, `markdown`, `pill` |

`i18n/message-fragment-list.ts` lists every owner's `index.ts`, one line each, sorted by path.
`i18n/catalogs.ts` assembles the five catalogs from that list at load time; no assembled catalog
file is committed. `MessageKey` is still the union of all English keys, so a screen naming a key
that no English fragment has fails to compile, and so does a locale file missing an English key.

To add strings, put them in a flat `{ "prefix.key": "English text" }` file and run
`node packages/web/scripts/i18n-add-keys.mjs <file>`; each key goes to the owner of its prefix,
into all five locale files with the English text as a stand-in until it is translated. A new
prefix is first added to the `prefixes` of the owning `index.ts`. A new feature with its own
strings copies an existing `messages/` directory (five JSON files and `index.ts`), renames the
export, and adds one line to `message-fragment-list.ts`. Review and terms below apply to every
fragment of a locale together.

`zh-TW` is written in Taiwan usage from the English, not converted from `zh-CN`: 登入 (not 登录),
設定 (not 设置), 伺服器 (not 服务器), 工作區, 機器人, 資料庫, 檔案, 網域, 訊息.

## Terms

| English | zh-CN | zh-TW | ja | es |
|---|---|---|---|---|
| workspace | 工作区 | 工作區 | ワークスペース | espacio de trabajo |
| Bot | Bot | 機器人 | ボット | bot |
| SOUL | SOUL | SOUL | SOUL | SOUL |
| chat | 聊天 | 對話 | チャット | chat |
| task | 任务 | 任務 | タスク | tarea |
| approval | 审批 | 核准 | 承認 | aprobación |
| work (ordinary UI); run (technical history/debugging only) | 工作；运行 | 工作；執行 | 作業；実行 | trabajo; ejecución |
| Organization | 组织 | 組織 | 組織 | organización |
| Owner / Admin / Member | 所有者 / 管理员 / 成员 | 擁有者 / 管理員 / 成員 | オーナー / 管理者 / メンバー | propietario / administrador / miembro |
| sign in | 登录 | 登入 | サインイン | iniciar sesión |
| settings | 设置 | 設定 | 設定 | configuración |
| server | 服务器 | 伺服器 | サーバー | servidor |
| Allowed websites | 允许的网站 | 允許的網站 | 許可されたウェブサイト | sitios web permitidos |
| Internal network | 内部网络 | 內部網路 | 内部ネットワーク | red interna |
| AI model / thinking depth | AI 模型 / 思考深度 | AI 模型 / 思考深度 | AI モデル / 思考の深さ | modelo de IA / profundidad de razonamiento |
| Another app | 外部应用 | 其他應用程式 | 別のアプリ | otra aplicación |
| Repeats | 重复方式 | 重複方式 | 繰り返し | repetición |
| take over / hand back | 接管 / 交还 | 接管 / 交還 | 操作を引き継ぐ / 操作を戻す | tomar el control / devolver el control |
| side chat (a Member's own one-bot chat, ADR-0022 amendment 1) | 单独聊天 | 單獨聊天 | 個別チャット | chat aparte |

Keys added on 2026-10-10 for the Member role and the proxied takeover screen (`chatPane.composer.roleNote`,
`chatPane.composer.sideChatHint`, `chatPane.takeover.screen*`, `threadMembership.roleNote`,
`threadRail.newThread.sideChat`, `threadRail.newThread.groupRoleNote`, `approvalCard.roleNote.*`,
`tasks.roleNote`, `learnedMemory.roleNote`, `knowledge.memory.roleNote`, and later the same day
`run.roleNote.cancel` and `runContextPanel.roleNote`) were machine-authored the same
way by the implementing agent and are pending native review like the rest.

Keys added on 2026-10-10 and revised on 2026-10-11 for **Account settings → Connect an agent**
(`account.agent.*`) are machine-authored the same way. `account.agent.prompt` is deliberately the
same English text in every catalog: it is an instruction for the person's agent, not for the
person, and the skill it installs is English. Translate the words around it, not the prompt. The
revised prompt deliberately contains no token or token assignment; credential enrollment is a
separate local secret-entry flow.

Keys added on 2026-10-11 for the live integration catalog (`integrations.categories.*`,
`integrations.featured.*`, `integrations.pagination.*`, `integrations.state.*` and
`integrations.summary.*`) are machine-authored and pending native review.

Keys added on 2026-10-12 for the read-only channel mirror and the channel card's recovery states
(`chatPane.channelMirror.*`, `integrations.channels.explain.*`, `integrations.channels.state.*`,
`integrations.channels.unavailable.*`, `integrations.channels.loadFailed`, `.retry`,
`.technicalDetails` and `.testSent`; issue #43) are machine-authored by the implementing agent
and pending native review. `integrations.channels.none` was removed.

Keys added or reworded on 2026-10-10 when the sidebar Settings gear and sign-out moved into
Account settings (`account.preferences.*`, `account.signOut.*`, `account.intro`,
`app.account.open`, `app.account.settings`) are machine-authored the same way. The Preferences and
Sign out texts are the former `app.preferences.*` and `app.footer.signOut*` strings, moved.

Keys added on 2026-10-12 for the approval card's tier labels (`approvalCard.subagent`,
`approvalCard.unclassified`, `approvalCard.unclassifiedWhy`; ADR-0002 amendment 3, A5) are
machine-authored and pending native review.

Keys added on 2026-10-18 for the bot editor's run statistics switch (`runStats.*` and
`roles.action.bot.setRunStats`; ADR-0050) are machine-authored and pending native review.

Keys added on 2026-10-19 for the workspace default bot (`botProfile.default*`,
`botProfile.makeDefault*`, `contacts.row.default`, `firstRunChecklist.step.talkToAssistant` and
`roles.action.workspace.setDefaultBot`; ADR-0051) are machine-authored and pending native review.

## What reviewers should know

- Role sentences are assembled: `roles.note` ("Only {who} can {does}.") and `roles.nextAction.*`
  take a role from `roles.who.*` and a verb phrase from the screen's own `does`/`how` keys (named
  `*roleNote*`, `*does*`, `*nextAction*`). A `does` text must read inside each of those
  templates, so review them together.
- Raw codes that English shows as they are (run statuses such as `waiting_approval`, lanes,
  triggers) are natural words in the other four.
- Spanish uses "equipo compartido" for the shared computer, so a team of bots is "un grupo de
  bots"; Chinese and Japanese plurals use only the `other` form.
- A few keys are fragments appended to another text: `mentionQuery.*` warnings, the
  `costs.slice.*` and `costAlerts.facts.*` tails. Keep their leading punctuation shape.
- Identifiers stay as they are in every locale: product names (Deskmates, WhatsApp, noVNC, Google
  Drive, PostgreSQL, Keycloak), file names (SOUL.md, MEMORY.md, SKILL.md), example paths
  and tool names in placeholders, cron expressions, UTC/USD/CSV/ID/API/URL/MCP/SSO.
- Primary UI copy says server, Allowed websites and Internal network. Protocol terms such as
  Gateway, proxy, bearer token, environment-variable names and raw cron expressions belong only
  in a folded Details or Advanced section when a person needs them to diagnose or configure the
  system.
- Not in the catalogs, so always English: Gateway-authored system messages stored in
  `thread_messages` (approval requests, outcome and cap notices, handoff diagnostics), Gateway
  error messages, SOUL, guidance and anything the model reads.
- The Help manual's chrome (`manual.*`) is in the catalogs; its topics are docs/guide/, which is
  English only. In any other locale the manual says so above each topic (`manual.englishOnly`)
  rather than presenting the English text as translated (issue #28).

## Checks

- `catalogs.test.ts`: the five catalogs have the same keys, every message is valid ICU, and a
  translation uses the same arguments and tags as English.
- `message-fragments.test.ts`: every fragment directory is listed in
  `message-fragment-list.ts`, every fragment has exactly the English keys in every locale, sorted,
  each key's prefix is one its owner declares, no prefix or key is in two fragments, and the
  assembled catalogs hash to the same text as the pre-split catalogs of 2026-10-13.
- `locale-render.test.tsx`: Chats, Tasks, Approvals, Management and People render in zh-CN with
  no key left in English and no English catalog text on screen.
- Missing a key at run time falls back to the English text, never to the key.

## Sign-off

A reviewer who has read a locale on the running UI adds a row: locale, name, date, scope read.

| Locale | Reviewer | Date | Scope |
|---|---|---|---|
