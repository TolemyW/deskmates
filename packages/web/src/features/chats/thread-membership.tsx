import {
  type BotDefinition,
  type BotId,
  CHAT_THREAD_MAX_MEMBERS,
  type ThreadId,
  type WorkspaceId,
} from "@deskmates/contracts";
import { Plus, UserRoundMinus } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import type { NamedThreadMember } from "../../api/types.js";
import { ApiError } from "../../api/types.js";
import { Avatar } from "../../components/ui/avatar.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { contactHref } from "../../router.js";
import { RoleNote, useCan } from "../../state/session-roles.js";

interface ThreadMembershipProps {
  api: ApiClient;
  threadId: ThreadId;
  workspaceId: WorkspaceId;
  editable: boolean;
  members: readonly NamedThreadMember[];
  /**
   * The member that took the latest unaddressed request (ADR-0005 amendment 2). A label, not a
   * permission: the owner can be removed and every member can still be addressed.
   */
  ownerBotId?: BotId | undefined;
  activity: ReadonlyMap<string, string>;
  onChanged: () => Promise<void>;
}

/** Membership edits are explicit: selecting a bot never posts a message or starts a run. */
export function ThreadMembership(props: ThreadMembershipProps) {
  const { api, threadId, workspaceId, members, ownerBotId, activity, onChanged } = props;
  const t = useT();
  // Adding or removing a bot changes the group: an Admin's (ADR-0022 amendment 1).
  const canEdit = useCan("thread.addMember").allowed;
  const editable = props.editable && canEdit;
  const ready = t("chatPane.activity.ready");
  // Activity is shown in the UI's language; these words mean the member is not working.
  const idle = [ready, t("chatPane.runStatus.failed"), t("chatPane.runStatus.cancelled")];
  const [open, setOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  const [bots, setBots] = useState<readonly BotDefinition[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<readonly BotId[]>([]);
  const [pending, setPending] = useState(false);
  const [removing, setRemoving] = useState<BotId>();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(undefined);
    void api
      .listBots(workspaceId)
      .then((result) => {
        if (!cancelled) setBots(result.filter((bot) => bot.workspaceId === workspaceId));
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, open, workspaceId]);

  const memberIds = new Set(members.map((member) => member.botId));
  const candidates = bots.filter((bot) => !memberIds.has(bot.id));
  const visible = candidates.filter((bot) =>
    `${bot.name} ${bot.role}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const room = Math.max(0, CHAT_THREAD_MAX_MEMBERS - members.length);
  // A live membership change can make a previously selected bot ineligible while the dialog is open.
  const validSelected = selected
    .filter((id) => candidates.some((bot) => bot.id === id))
    .slice(0, room);
  const busy = pending || removing !== undefined;

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const botIds = validSelected;
    if (!editable || botIds.length === 0 || busy) return;
    setPending(true);
    setError(undefined);
    try {
      await api.addThreadMembers(threadId, botIds);
      await onChanged();
      setSelected([]);
      setQuery("");
      setOpen(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  const remove = async (member: NamedThreadMember) => {
    if (!editable || members.length <= 1 || busy) return;
    setRemoving(member.botId);
    setError(undefined);
    try {
      await api.removeThreadMember(threadId, member.botId);
      await onChanged();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? t("threadMembership.removeBusy", { name: member.name, detail: err.message })
          : errorMessage(err),
      );
    } finally {
      setRemoving(undefined);
    }
  };

  return (
    <div className="thread-membership">
      <ul className="member-list" aria-label={t("threadMembership.membersLabel")}>
        {members.map((member) => (
          <li
            key={member.botId}
            className={
              idle.includes(activity.get(member.botId) ?? ready) ? "member" : "member active"
            }
          >
            <Avatar name={member.name} />
            <span className="member-name">
              <a href={contactHref(member.botId)} title={t("threadMembership.openProfile")}>
                {member.name}
              </a>
            </span>
            {members.length > 1 && member.botId === ownerBotId ? (
              <span className="owner-mark" title={t("threadMembership.ownerTitle")}>
                {t("threadMembership.owner")}
              </span>
            ) : null}
            <span className="muted small">{activity.get(member.botId) ?? ready}</span>
            {editable && managing ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="ml-1 size-6 rounded-md"
                aria-label={t("threadMembership.removeLabel", { name: member.name })}
                title={
                  members.length <= 1
                    ? t("threadMembership.needsOneBot")
                    : t("threadMembership.removeTitle", { name: member.name })
                }
                disabled={busy || members.length <= 1}
                onClick={() => void remove(member)}
              >
                <UserRoundMinus aria-hidden="true" />
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {editable ? (
        <div className="member-management-actions">
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={t("threadMembership.addBot")}
            disabled={busy || room === 0}
            title={room === 0 ? t("threadMembership.maxBots") : undefined}
            onClick={() => {
              setError(undefined);
              setOpen(true);
            }}
          >
            <Plus aria-hidden="true" /> {t("threadMembership.addBot")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={managing}
            onClick={() => setManaging(!managing)}
          >
            {t(managing ? "threadMembership.done" : "threadMembership.manage")}
          </Button>
        </div>
      ) : null}
      {props.editable ? (
        <RoleNote action="thread.addMember" does={t("threadMembership.roleNote")} />
      ) : null}
      {error && !open ? (
        <p className="error basis-full" role="alert">
          {error}
        </p>
      ) : null}
      {editable ? (
        <Dialog
          open={open}
          onOpenChange={(next) => {
            if (!busy) setOpen(next);
          }}
        >
          <DialogContent
            className="max-w-lg"
            closeLabel={t("threadMembership.dialog.close")}
            aria-describedby="add-bot-description"
          >
            <DialogTitle className="pr-8 text-lg font-semibold">
              {t("threadMembership.dialog.title")}
            </DialogTitle>
            <DialogDescription
              id="add-bot-description"
              className="mt-1 text-sm text-muted-foreground"
            >
              {t("threadMembership.dialog.description")}
            </DialogDescription>
            {loading ? (
              <output className="mt-5 text-sm text-muted-foreground">
                {t("threadMembership.dialog.loading")}
              </output>
            ) : null}
            {loadError ? (
              <p className="error mt-4" role="alert">
                {loadError}
              </p>
            ) : null}
            {!loading && !loadError ? (
              <form
                onSubmit={(event) => void add(event)}
                className="mt-5 flex min-h-0 flex-col gap-4"
              >
                {candidates.length > 0 ? (
                  <>
                    <Input
                      aria-label={t("threadMembership.dialog.searchLabel")}
                      placeholder={t("threadMembership.dialog.searchPlaceholder")}
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                    <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
                      {visible.length === 0 ? (
                        <p className="p-2 text-sm text-muted-foreground">
                          {t("threadMembership.dialog.noMatch")}
                        </p>
                      ) : null}
                      {visible.map((bot) => {
                        const checked = validSelected.includes(bot.id);
                        return (
                          <label
                            key={bot.id}
                            className="flex cursor-pointer items-start gap-3 rounded-md p-2 hover:bg-secondary"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={busy || (!checked && validSelected.length >= room)}
                              onChange={() =>
                                setSelected((current) =>
                                  checked
                                    ? current.filter((id) => id !== bot.id)
                                    : [...current, bot.id],
                                )
                              }
                            />
                            <span className="min-w-0">
                              <span className="block font-medium">{bot.name}</span>
                              {bot.role ? (
                                <span className="block text-sm text-muted-foreground">
                                  {bot.role}
                                </span>
                              ) : null}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t("threadMembership.dialog.selected", {
                        selected: validSelected.length,
                        room,
                      })}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t.rich("threadMembership.dialog.allMembers", {
                      link: (chunks) => <a href="#/manage">{chunks}</a>,
                    })}
                  </p>
                )}
                {error ? (
                  <p className="error" role="alert">
                    {error}
                  </p>
                ) : null}
                <div className="flex justify-end gap-2">
                  <Button type="button" onClick={() => setOpen(false)} disabled={busy}>
                    {t("threadMembership.dialog.cancel")}
                  </Button>
                  <Button
                    type="submit"
                    variant="default"
                    disabled={busy || validSelected.length === 0 || room === 0}
                  >
                    {pending
                      ? t("threadMembership.dialog.adding")
                      : t("threadMembership.dialog.submit")}
                  </Button>
                </div>
              </form>
            ) : null}
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
