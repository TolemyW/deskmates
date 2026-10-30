// A presentation of persisted Gateway handoff notices. The stored/model-facing body is untouched.
import {
  type ThreadId,
  type ThreadMessage,
  isThreadLinkAttachmentMime,
} from "@deskmates/contracts";
import { useState } from "react";
import { useT } from "../../i18n/i18n-provider.js";
import { useTuneView } from "../../lib/interface-view.js";
import { threadHref } from "../../router.js";
import { MessageContent } from "./message-content.js";

export type HandoffPresentation = {
  conversation?: string;
  name: string;
  recipient?: string;
  state: "started" | "returned" | "silent" | "forwarded" | "failed" | "stopped";
  reply?: string;
};

/** Recognize Gateway system notices with a durable conversation or run reference, never bot prose. */
export function handoffPresentation(message: ThreadMessage): HandoffPresentation | undefined {
  if (message.authorKind !== "system") return undefined;
  const attachment = message.attachments.find((a) => isThreadLinkAttachmentMime(a.mimeType));
  if (!attachment && !message.runId) return undefined;
  const started = /^([\p{L}\p{N}_.-]{1,64}) handed off to ([\p{L}\p{N}_.-]{1,64})\.$/u.exec(
    message.body,
  );
  if (started && attachment)
    return {
      conversation: attachment.ref,
      name: started[1] ?? "",
      recipient: started[2] ?? "",
      state: "started",
    };
  const match = /^Delegation outcome: ([\p{L}\p{N}_.-]{1,64}) (.+)/u.exec(
    message.body.split("\n")[0] ?? "",
  );
  if (!match) return undefined;
  const name = match[1] ?? "";
  const headline = match[2] ?? "";
  const state = headline.startsWith("finished the work ")
    ? "returned"
    : headline.startsWith("failed the work ")
      ? "failed"
      : headline.startsWith("was stopped ")
        ? "stopped"
        : headline.startsWith("ended the work ") &&
            headline.includes("without posting a reply (silent)")
          ? "silent"
          : headline.startsWith("ended the work ") && headline.includes("after handing it on")
            ? "forwarded"
            : undefined;
  if (!state) return undefined;
  const wrapper = `\nReply:\n<untrusted source="bot:${name}">\n`;
  const start = message.body.indexOf(wrapper);
  const reply =
    start !== -1 && message.body.endsWith("\n</untrusted>")
      ? message.body.slice(start + wrapper.length, -"\n</untrusted>".length)
      : undefined;
  return {
    ...(attachment ? { conversation: attachment.ref } : {}),
    name,
    state,
    ...(reply === undefined ? {} : { reply }),
  };
}

/** A durable outcome for this failed run replaces its duplicate; another supervisor run stays. */
export function hasHandoffOutcome(
  run: { id: string; status: string },
  messages: readonly ThreadMessage[],
): boolean {
  return (
    (run.status === "failed" || run.status === "stopped") &&
    messages.some(
      (message) => message.runId === run.id && handoffPresentation(message)?.state === run.status,
    )
  );
}

export function HandoffMessage({
  message,
  presentation,
}: { message: ThreadMessage; presentation: HandoffPresentation }) {
  const t = useT();
  const tune = useTuneView();
  const [original, setOriginal] = useState(false);
  const title =
    presentation.state === "started"
      ? t("chatPane.handoff.started", { from: presentation.name, to: presentation.recipient ?? "" })
      : t(`chatPane.handoff.${presentation.state}`, { name: presentation.name });
  return (
    <div className="body handoff-notice">
      <p className="handoff-title">{title}</p>
      {presentation.reply !== undefined ? (
        <>
          <p className="small muted">{t("chatPane.handoff.reply", { name: presentation.name })}</p>
          <MessageContent
            body={presentation.reply}
            author={presentation.name}
            collapsible
            prominent
            renderBody={(body) => <div className="handoff-reply">{body}</div>}
          />
        </>
      ) : null}
      <div className="handoff-actions">
        {presentation.conversation ? (
          <a className="handoff-link" href={threadHref(presentation.conversation as ThreadId)}>
            {t("chatPane.handoff.open")}
          </a>
        ) : null}
        {tune ? (
          <button
            className="link-button small"
            type="button"
            data-chat-disclosure
            aria-expanded={original}
            onClick={() => setOriginal((value) => !value)}
          >
            {t("chatPane.history.original")}
          </button>
        ) : null}
      </div>
      {tune && original ? <pre className="history-original">{message.body}</pre> : null}
    </div>
  );
}
