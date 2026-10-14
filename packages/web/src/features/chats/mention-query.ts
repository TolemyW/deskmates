// Pure helpers behind the composer's @mention picker. The Gateway recognises `@name` only when the
// name follows `@` directly and the `@` does not follow a word character (contracts
// `parseMentions`); typing `@ team_chief` or misspelling a name silently becomes "no mention",
// which routes the message to whoever the Gateway picks. The picker inserts exact names so that
// cannot happen.

import { type BotId, type GroupRouting, parseMentions } from "@deskmates/contracts";
import { currentI18n } from "../../i18n/intl.js";

export interface MentionMember {
  botId: BotId;
  name: string;
}

/** The `@partial` being typed at the caret, if any: where it starts and what follows the `@`. */
export interface ActiveMention {
  /** Index of the `@`. */
  start: number;
  /** Characters typed after the `@`, up to the caret. */
  query: string;
}

/** Same boundary rule as the Gateway: `@` at the start or after a non-word, non-`@` character. */
const ACTIVE = /(^|[^\w@])@([\w-]*)$/;

export function activeMention(text: string, caret: number): ActiveMention | undefined {
  const match = ACTIVE.exec(text.slice(0, caret));
  if (!match) return undefined;
  const query = match[2] ?? "";
  return { start: caret - query.length - 1, query };
}

export const EVERYONE = "everyone";

/** Member names (then `everyone`) whose name starts with the query, case-insensitively. */
export function mentionOptions(members: readonly MentionMember[], query: string): string[] {
  const q = query.toLowerCase();
  const names = members.map((m) => m.name).filter((n) => n.toLowerCase().startsWith(q));
  return EVERYONE.startsWith(q) ? [...names, EVERYONE] : names;
}

/**
 * Replace the active `@partial` with `@name ` and return the new text and caret. A space already
 * after the caret is reused rather than doubled.
 */
export function applyMention(
  text: string,
  mention: ActiveMention,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const before = text.slice(0, mention.start);
  const after = text.slice(caret);
  const inserted = after.startsWith(" ") ? `@${name}` : `@${name} `;
  return {
    text: before + inserted + after,
    caret: before.length + inserted.length + (after.startsWith(" ") ? 1 : 0),
  };
}

export interface MentionPreview {
  /** Bot names this message will wake, in mention order. */
  woken: string[];
  everyone: boolean;
  /** `@names` that match no member: they wake nobody. */
  unknown: string[];
}

const ANY = /(^|[^\w@])@([\w-]+)/g;

/** Who a message wakes, by the Gateway's own parser, plus the `@names` it will ignore. */
export function previewMentions(body: string, members: readonly MentionMember[]): MentionPreview {
  const parsed = parseMentions(body, members);
  const everyone = parsed.some((m) => m.kind === "everyone");
  const nameOf = new Map(members.map((m) => [m.botId, m.name]));
  const woken = everyone
    ? []
    : parsed.flatMap((m) => (m.kind === "bot" ? [nameOf.get(m.botId) ?? m.botId] : []));
  const known = new Set([...members.map((m) => m.name.toLowerCase()), EVERYONE]);
  const unknown = [
    ...new Set(
      [...body.matchAll(ANY)]
        .map((m) => m[2] ?? "")
        .filter((name) => name !== "" && !known.has(name.toLowerCase())),
    ),
  ];
  return { woken, everyone, unknown };
}

/** What the composer says about a message with no valid mention. */
export interface UnaddressedRoute {
  /** The preview line when the message mentions nobody. */
  line: string;
  /** Tail of the unknown-recipient warning when none of the message's mentions is valid. */
  warning: string;
}

/**
 * Where a message with no valid mention goes (ADR-0005 amendment 2). A missing routing is an
 * older Gateway, which walks every member; a one-member thread has nobody else to offer it to,
 * so its wording does not change. An owner that is no longer a member is not offered anything.
 */
export function unaddressedRoute(
  members: readonly MentionMember[],
  routing: GroupRouting | undefined,
  ownerBotId: BotId | undefined,
): UnaddressedRoute {
  const { t } = currentI18n();
  if (routing !== "owner-v1" || members.length < 2) {
    return { line: t("mentionQuery.walk.line"), warning: t("mentionQuery.walk.warning") };
  }
  const owner = members.find((m) => m.botId === ownerBotId);
  if (owner)
    return {
      line: t("mentionQuery.owner.line", { name: owner.name }),
      warning: t("mentionQuery.owner.warning", { name: owner.name }),
    };
  return {
    line: t("mentionQuery.oneAtATime.line"),
    warning: t("mentionQuery.oneAtATime.warning"),
  };
}
