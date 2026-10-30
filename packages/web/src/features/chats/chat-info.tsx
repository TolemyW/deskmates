import { DetailPane, DetailPaneContent } from "../../components/ui/detail-pane.js";
// The information panel of one chat, the way a messaging app shows "chat info": who is in it,
// what the task notes say, which files were mentioned, which approvals were asked, and the
// members' desktops. Everything here is read from records the chat already has; the panel adds
// no state of its own.

import {
  type Approval,
  type ThreadMessage,
  type WorkspaceId,
  isThreadLinkAttachmentMime,
} from "@deskmates/contracts";
import { Activity, FileText, Info, Monitor, ShieldCheck, Sparkles, Users } from "lucide-react";
import { useMemo, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import type { NamedThreadMember, ThreadDetailView } from "../../api/types.js";
import { Button } from "../../components/ui/button.js";
import { DialogTitle } from "../../components/ui/dialog.js";
import { Pill } from "../../components/ui/pill.js";
import { formatTime } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { useTuneView } from "../../lib/interface-view.js";
import { decisionLabel } from "../approvals/approval-card.js";
import { DesktopRail } from "../computer/desktop-rail.js";
import { splitWorkspacePaths } from "../files/path-links.js";
import { WorkspaceFilePreview } from "../files/workspace-file-preview.js";
import { LearnedMemoryScreen } from "../knowledge/learned-memory.js";

export interface ChatInfoProps {
  api: ApiClient;
  detail: ThreadDetailView;
  members: readonly NamedThreadMember[];
  messages: readonly ThreadMessage[];
  approvals: readonly Approval[];
  workspaceId: WorkspaceId;
  /** The membership editor (chips with activity, add and remove); it lives here, not in the header. */
  membership: React.ReactNode;
  /** Activity of this chat: one card per run, grouped by request round (ADR-0033). */
  activity?: React.ReactNode;
  shown: boolean;
  onClose?: (() => void) | undefined;
  /**
   * Pause or Resume the conversation (ADR-0005 amendment 3, decision 23); given only to a session
   * that may, an Owner or Admin. Absent hides the control.
   */
  onSetStatus?: (status: "paused" | "active") => void;
  statusBusy?: boolean;
}

/** The paused state in the header note: why, and until when for a turn-budget pause. */
function pausedNote(
  thread: ThreadDetailView["thread"],
  t: ReturnType<typeof useT>,
): string | undefined {
  if (thread.status !== "paused") return undefined;
  if (thread.pauseReason === "operator") return t("chatInfo.status.pausedOperator");
  if (thread.resumeAt)
    return t("chatInfo.status.pausedUntil", { time: formatTime(thread.resumeAt) });
  return t("chatInfo.status.paused");
}

/**
 * The turn budget the router enforces (ADR-0005 amendment 5 decision 38), not the stored row:
 * a workspace setting wins, `off` reads as `off`; an older Gateway sends only the row.
 */
export function shownTurnBudget(detail: ThreadDetailView, off: string): string | number {
  const effective = detail.effectiveTurnBudget;
  if (!effective) return detail.thread.turnBudget;
  return effective.value === null ? off : effective.value;
}

type Section = "members" | "activity" | "notes" | "files" | "approvals" | "desktops";

export function ChatInfo(props: ChatInfoProps) {
  const { api, detail, members, messages, approvals, workspaceId, membership, onClose } = props;
  const [open, setOpen] = useState<Section | null>("members");
  const t = useT();
  // The per-run activity cards and the routing facts are for tuning (use-and-tune-views.md).
  const tune = useTuneView();

  // Files a message mentioned: declared attachments and absolute workspace paths in the text.
  const files = useMemo(() => {
    const seen = new Map<string, { path: string; by: string; ts: string }>();
    for (const m of messages) {
      for (const a of m.attachments) {
        if (!isThreadLinkAttachmentMime(a.mimeType) && !seen.has(a.ref)) {
          seen.set(a.ref, { path: a.ref, by: m.authorId, ts: m.ts });
        }
      }
      if (m.authorKind === "system") continue;
      for (const segment of splitWorkspacePaths(m.body)) {
        if (segment.kind === "path" && !seen.has(segment.path)) {
          seen.set(segment.path, { path: segment.path, by: m.authorId, ts: m.ts });
        }
      }
    }
    return [...seen.values()].reverse();
  }, [messages]);

  const nameOf = (id: string) => members.find((m) => m.botId === id)?.name ?? id;
  const sorted = [...approvals].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const section = (key: Section, icon: React.ReactNode, title: string, count?: number) => (
    <button
      type="button"
      className={`info-section-head${open === key ? " open" : ""}`}
      aria-expanded={open === key}
      onClick={() => setOpen(open === key ? null : key)}
    >
      {icon}
      <span>{title}</span>
      {count !== undefined ? <span className="muted">{count}</span> : null}
    </button>
  );

  // Only what is unusual: a turn limit when one is on, paused when the chat is paused, and for a
  // group the installation's routing mode (issue #15), which no per-chat control changes.
  const budget = shownTurnBudget(detail, t("limits.off"));
  const paused = pausedNote(detail.thread, t);
  const routing =
    tune && detail.thread.kind === "chat" && members.length > 1 ? detail.groupRouting : undefined;
  const headerNote = [
    ...(tune && typeof budget === "number" ? [t("chatInfo.turnLimit", { budget })] : []),
    ...(paused ? [paused] : []),
  ].join(" · ");
  const isPaused = detail.thread.status === "paused";

  return (
    <DetailPane
      open={props.shown}
      onOpenChange={(next) => {
        if (!next) onClose?.();
      }}
    >
      <DetailPaneContent
        placement="right"
        className="chat-info-dialog"
        closeLabel={t("chatInfo.hide")}
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          document.getElementById(`chat-info-toggle-${detail.thread.id}`)?.focus();
        }}
      >
        <DialogTitle className="sr-only">{t("chatInfo.label")}</DialogTitle>
        <section className="chat-info" aria-label={t("chatInfo.label")}>
          <header>
            <span className="eyebrow">
              <Info size={12} />{" "}
              {detail.thread.kind === "bus"
                ? t("chatInfo.kind.bus")
                : members.length > 1
                  ? t("chatInfo.kind.group")
                  : t("chatInfo.kind.private")}
            </span>
            <h2>{detail.thread.title || nameOf(members[0]?.botId ?? "")}</h2>
            {headerNote || routing ? (
              <p className="muted small">
                {headerNote}
                {headerNote && routing ? " · " : null}
                {routing ? (
                  <span data-testid="chat-routing" title={t("chatInfo.routing.title")}>
                    {t(`chatInfo.routing.${routing}`)}
                  </span>
                ) : null}
              </p>
            ) : null}
            {props.onSetStatus && detail.thread.kind === "chat" ? (
              <Button
                type="button"
                className="chat-info-pause"
                disabled={props.statusBusy}
                onClick={() => props.onSetStatus?.(isPaused ? "active" : "paused")}
              >
                {isPaused ? t("chatInfo.resume") : t("chatInfo.pause")}
              </Button>
            ) : null}
          </header>

          {section("members", <Users size={15} />, t("chatInfo.section.members"), members.length)}
          <div className={open === "members" ? "info-body" : "info-body hidden"}>{membership}</div>

          {tune && props.activity ? (
            <>
              {section("activity", <Activity size={15} />, t("chatInfo.section.activity"))}
              {open === "activity" ? <div className="info-body">{props.activity}</div> : null}
            </>
          ) : null}

          {section("notes", <Sparkles size={15} />, t("chatInfo.section.notes"))}
          {open === "notes" ? (
            <div className="info-body">
              <LearnedMemoryScreen
                api={api}
                embedded
                workspaceId={workspaceId}
                threadId={detail.thread.id}
              />
            </div>
          ) : null}

          {section("files", <FileText size={15} />, t("chatInfo.section.files"), files.length)}
          {open === "files" ? (
            <div className="info-body">
              {files.length === 0 ? (
                <p className="muted small">{t("chatInfo.noFiles")}</p>
              ) : (
                files.map((f) => (
                  <div key={f.path} className="info-file">
                    <WorkspaceFilePreview
                      api={api}
                      workspaceId={workspaceId}
                      path={f.path}
                      compact
                      source={nameOf(f.by)}
                      sourceId={f.by}
                    />
                  </div>
                ))
              )}
            </div>
          ) : null}

          {section(
            "approvals",
            <ShieldCheck size={15} />,
            t("chatInfo.section.approvals"),
            sorted.length,
          )}
          {open === "approvals" ? (
            <ul className="info-approvals">
              {sorted.length === 0 ? (
                <li className="muted small">{t("chatInfo.noApprovals")}</li>
              ) : (
                sorted.map((a) => (
                  <li key={a.id}>
                    <Pill tone={a.decision ? "neutral" : "warning"}>{a.riskLevel}</Pill>
                    <span>
                      <strong>
                        {a.kind === "continuation" ? t("chatInfo.continue") : a.action.toolName}
                      </strong>
                      <span className="muted small">
                        {a.action.argumentSummary ?? ""} · {decisionLabel(a)}
                      </span>
                    </span>
                  </li>
                ))
              )}
            </ul>
          ) : null}

          {section(
            "desktops",
            <Monitor size={15} />,
            t("chatInfo.section.desktops"),
            members.length,
          )}
          <div className={open === "desktops" ? "info-body" : "info-body hidden"}>
            <DesktopRail api={api} members={members} workspaceId={workspaceId} />
          </div>
        </section>
      </DetailPaneContent>
    </DetailPane>
  );
}
