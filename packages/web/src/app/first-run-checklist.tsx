// The first-run checklist on the home screen (issue #22): four steps for an Owner or Admin,
// three when the workspace has a default bot to talk to (ADR-0051), each checked from what exists
// in the team rather than from clicks, shown until the person dismisses it. Dismissal is their stored preference (`PATCH /auth/preferences`), so it holds on
// every browser. The shell provides the context; a screen rendered without it shows nothing.

import { Circle, CircleCheck } from "lucide-react";
import { type ReactNode, createContext, useContext, useEffect, useState } from "react";
import type { MembersClient } from "../api/members-client.js";
import { Button } from "../components/ui/button.js";
import type { MessageKey } from "../i18n/catalogs.js";
import { useT } from "../i18n/i18n-provider.js";
import { useCan } from "../state/session-roles.js";
import { useWorkspaceForCalls } from "../state/workspace-scope.js";

export interface FirstRunGuide {
  /** The person dismissed the checklist (their stored preference). */
  dismissed: boolean;
  /** Store the dismissal; rejects when the Gateway refuses it. */
  dismiss(): Promise<void>;
  /** Reads who else is in the team, for "Invite a person". */
  people: Pick<MembersClient, "pageMembers" | "pageInvitations">;
  /** The signed-in person, who does not count as invited. */
  userId: string;
}

const FirstRunContext = createContext<FirstRunGuide | undefined>(undefined);

export function FirstRunProvider({
  guide,
  children,
}: {
  guide: FirstRunGuide;
  children: ReactNode;
}) {
  return <FirstRunContext.Provider value={guide}>{children}</FirstRunContext.Provider>;
}

/** The workspace's default bot (ADR-0051) and where its private chat opens. */
export interface FirstRunAssistant {
  name: string;
  href: string;
}

export function FirstRunChecklist(props: {
  workspaces: number;
  bots: number;
  threads: number;
  assistant?: FirstRunAssistant | undefined;
}) {
  const guide = useContext(FirstRunContext);
  // Owners and Admins: the roles that may take the steps (inviting needs an Admin or Owner).
  const manager = useCan("people.invite").allowed;
  if (!guide || guide.dismissed || !manager) return null;
  return <Checklist guide={guide} {...props} />;
}

function Checklist({
  guide,
  workspaces,
  bots,
  threads,
  assistant,
}: {
  guide: FirstRunGuide;
  workspaces: number;
  bots: number;
  threads: number;
  assistant?: FirstRunAssistant | undefined;
}) {
  const t = useT();
  const [invited, setInvited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { people, userId } = guide;
  // People are per workspace (ADR-0022 amendment 6 W9).
  const { workspaceId, pending } = useWorkspaceForCalls();

  useEffect(() => {
    if (pending) return;
    let live = true;
    // Totals, not list lengths (#113 slice M): two active people means someone besides this one,
    // and any invitation counts. Neither read is the whole list.
    Promise.all([
      people.pageMembers(workspaceId, { status: "active", limit: 2 }),
      people.pageInvitations(workspaceId, { limit: 1 }),
    ])
      .then(([members, invitations]) => {
        if (!live) return;
        setInvited(
          invitations.total > 0 ||
            members.total > 1 ||
            members.members.some((member) => member.userId !== userId),
        );
      })
      .catch(() => {
        // Without the list the step stays unchecked; the rest of the checklist still helps.
      });
    return () => {
      live = false;
    };
  }, [people, userId, workspaceId, pending]);

  const step = (label: MessageKey, done: boolean, href: string) => ({
    key: label,
    text: t(label),
    done,
    href,
  });
  // ADR-0051: a workspace with a default bot starts by talking to it, which also opens a chat;
  // the step is done once the assistant has set up a teammate.
  const steps = assistant
    ? [
        step("firstRunChecklist.step.createWorkspace", workspaces > 0, "#/computer"),
        {
          key: "firstRunChecklist.step.talkToAssistant",
          text: t("firstRunChecklist.step.talkToAssistant", { name: assistant.name }),
          done: bots > 1,
          href: assistant.href,
        },
        step("firstRunChecklist.step.invitePerson", invited, "#/members"),
      ]
    : [
        step("firstRunChecklist.step.createWorkspace", workspaces > 0, "#/computer"),
        step("firstRunChecklist.step.createBot", bots > 0, "#/contacts"),
        step("firstRunChecklist.step.openChat", threads > 0, "#/threads"),
        step("firstRunChecklist.step.invitePerson", invited, "#/members"),
      ];

  const dismiss = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await guide.dismiss();
    } catch {
      setError(t("firstRunChecklist.dismissFailed"));
      setBusy(false);
    }
  };

  return (
    <section className="first-run-checklist" aria-label={t("firstRunChecklist.title")}>
      <h2>{t("firstRunChecklist.title")}</h2>
      <ul aria-label={t("firstRunChecklist.title")}>
        {steps.map((item) => (
          <li key={item.key} className={item.done ? "done" : undefined}>
            {item.done ? (
              <CircleCheck size={16} aria-hidden="true" />
            ) : (
              <Circle size={16} aria-hidden="true" />
            )}
            <span className="sr-only">
              {item.done ? t("firstRunChecklist.done") : t("firstRunChecklist.toDo")}
            </span>
            {item.done ? <span>{item.text}</span> : <a href={item.href}>{item.text}</a>}
          </li>
        ))}
      </ul>
      {error ? (
        <p role="alert" className="error small">
          {error}
        </p>
      ) : null}
      <Button variant="ghost" type="button" disabled={busy} onClick={() => void dismiss()}>
        {t("firstRunChecklist.dismiss")}
      </Button>
    </section>
  );
}
