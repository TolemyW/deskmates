// Present Gateway receipts quietly without changing their durable/model-facing text.
import type { BotDefinition, ThreadMessage } from "@deskmates/contracts";
import { ChevronRight, Sparkles, UserRoundPlus } from "lucide-react";
import { useT } from "../../i18n/i18n-provider.js";
import { useTuneView } from "../../lib/interface-view.js";
import { contactHref, contactsHref } from "../contacts/route.js";
import { knowledgeHref } from "../knowledge/route.js";

export type ActivityNotice =
  | { kind: "memory"; gated: number; excluded: number; untrusted: number }
  | { kind: "created"; name: string; role: string };

export function activityNotice(message: ThreadMessage): ActivityNotice | undefined {
  if (message.authorKind !== "system" || message.attachments.length) return undefined;
  const created = /^@[\w-]+ created @([\w-]+) \(([\s\S]*)\)\.$/.exec(message.body);
  if (created) return { kind: "created", name: created[1] ?? "", role: created[2] ?? "" };
  if (!message.body.startsWith("Memory update:")) return undefined;
  const count = (suffix: string) =>
    Number(new RegExp(`(\\d+) item\\(s\\) ${suffix}`).exec(message.body)?.[1] ?? 0);
  const gated = count("need human confirmation");
  const excluded = count("were not applied as current memory");
  const untrusted = count("were saved as untrusted");
  return gated || excluded || untrusted
    ? { kind: "memory", gated, excluded, untrusted }
    : undefined;
}

export function ActivityNoticeRow({
  message,
  notice,
  bots,
  reveal = false,
}: {
  message: ThreadMessage;
  notice: ActivityNotice;
  bots: readonly BotDefinition[] | undefined;
  reveal?: boolean;
}) {
  const t = useT();
  const tune = useTuneView();
  const created = notice.kind === "created";
  const bot = created ? bots?.find((b) => b.name === notice.name) : undefined;
  return (
    <li id={`message-${message.id}`} className="chat-activity-notice">
      <details open={reveal || undefined}>
        <summary data-chat-disclosure>
          {created ? (
            <UserRoundPlus size={16} aria-hidden="true" />
          ) : (
            <Sparkles size={16} aria-hidden="true" />
          )}
          <span>
            {created
              ? t("chatPane.activity.created", { name: notice.name })
              : t(
                  notice.gated || notice.excluded
                    ? "chatPane.activity.memory"
                    : "chatPane.activity.observed",
                )}
          </span>
          <ChevronRight size={14} aria-hidden="true" className="chat-activity-chevron" />
        </summary>
        <div className="chat-activity-detail">
          {created ? (
            <p>{notice.role}</p>
          ) : (
            <>
              {notice.gated > 0 ? (
                <p>{t("chatPane.activity.gated", { count: notice.gated })}</p>
              ) : null}
              {notice.excluded > 0 ? (
                <p>{t("chatPane.activity.excluded", { count: notice.excluded })}</p>
              ) : null}
              {notice.untrusted > 0 ? (
                <p>{t("chatPane.activity.untrusted", { count: notice.untrusted })}</p>
              ) : null}
            </>
          )}
          <a
            href={
              created ? (bot ? contactHref(bot.id) : contactsHref()) : knowledgeHref("observations")
            }
          >
            {t(created ? "chatPane.activity.openBot" : "chatPane.activity.review")}
          </a>
          {tune ? (
            <details>
              <summary>{t("chatPane.activity.audit")}</summary>
              <pre>{message.body}</pre>
            </details>
          ) : null}
        </div>
      </details>
    </li>
  );
}
