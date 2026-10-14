// The message board of the selected workspace (ADR-0022 amendment 6 W10). Everyone in the
// workspace reads it and posts on it, Guests included; the composer says so. Posts are plain text
// (never Markdown or HTML) and inert: a post starts no run, whatever it mentions. An author edits
// and withdraws their own posts; an Admin or Owner hides and unhides any, and sees hidden ones
// marked. The list is paged newest first; "Load older" follows the Gateway's cursor.

import type { BoardPostVersionView, BoardPostView, WorkspaceId } from "@deskmates/contracts";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { subscribeEvents } from "../../api/events.js";
import { Button } from "../../components/ui/button.js";
import { errorMessage, formatDateTime } from "../../format.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";
import { useWorkspaceScope } from "../../state/workspace-scope.js";

/** Posts per page; the Gateway caps a page at `BOARD_PAGE_MAX`. */
export const BOARD_PAGE_SIZE = 50;

const OP_WORDS: Readonly<Record<BoardPostVersionView["op"], MessageKey>> = {
  post: "board.history.op.post",
  edit: "board.history.op.edit",
  withdraw: "board.history.op.withdraw",
  hide: "board.history.op.hide",
  unhide: "board.history.op.unhide",
};

interface BoardList {
  posts: BoardPostView[];
  nextCursor: string | undefined;
  canModerate: boolean;
  /** Pages loaded so far; a refresh keeps the older ones. */
  pages: number;
}

const EMPTY: BoardList = { posts: [], nextCursor: undefined, canModerate: false, pages: 0 };

/** A fresh idempotency key for one post; kept across retries of the same draft. */
function newRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}-${Math.random()}`;
}

export function BoardScreen({ api }: { api: ApiClient }) {
  const t = useT();
  const scope = useWorkspaceScope(api);
  const workspace = scope.current;
  return (
    <section className="board-screen resource-page page-container">
      <header>
        <h1>{t("board.title")}</h1>
        <p className="muted">{t("board.intro")}</p>
      </header>
      {workspace ? (
        <Board key={workspace.id} api={api} workspaceId={workspace.id} />
      ) : scope.loaded ? (
        <p className="muted">{t("board.noWorkspace")}</p>
      ) : null}
    </section>
  );
}

function Board({ api, workspaceId }: { api: ApiClient; workspaceId: WorkspaceId }) {
  const t = useT();
  const [list, setList] = useState<BoardList>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string>();
  const revision = useRef(0);

  /** Reads the newest page again and keeps the older pages already shown. */
  const refresh = useCallback(async () => {
    const request = ++revision.current;
    try {
      const page = await api.listBoardPosts(workspaceId, { limit: BOARD_PAGE_SIZE });
      if (request !== revision.current) return;
      setList((previous) => {
        const fresh = new Set(page.posts.map((post) => post.id));
        const oldest = page.posts.at(-1)?.createdAt;
        const older =
          previous.pages > 1 && oldest !== undefined
            ? previous.posts.filter((post) => !fresh.has(post.id) && post.createdAt < oldest)
            : [];
        return {
          posts: [...page.posts, ...older],
          nextCursor: previous.pages > 1 ? previous.nextCursor : page.nextCursor,
          canModerate: page.canModerate,
          pages: Math.max(previous.pages, 1),
        };
      });
      setLoaded(true);
      setError(undefined);
    } catch (err) {
      if (request === revision.current) {
        setError(errorMessage(err));
        setLoaded(true);
      }
    }
  }, [api, workspaceId]);

  useEffect(() => {
    void refresh();
    // Another person's post, edit or moderation arrives as a `board` frame for this workspace.
    const stop = globalThis.EventSource
      ? subscribeEvents({
          onReconnect: () => void refresh(),
          onEvent: (event) => {
            if (event.type === "board" && event.workspaceId === workspaceId) void refresh();
          },
        })
      : () => {};
    return () => {
      revision.current += 1;
      stop();
    };
  }, [refresh, workspaceId]);

  const loadOlder = async (): Promise<void> => {
    const before = list.nextCursor;
    if (before === undefined || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await api.listBoardPosts(workspaceId, { before, limit: BOARD_PAGE_SIZE });
      setList((previous) => {
        const known = new Set(previous.posts.map((post) => post.id));
        return {
          posts: [...previous.posts, ...page.posts.filter((post) => !known.has(post.id))],
          nextCursor: page.nextCursor,
          canModerate: page.canModerate,
          pages: previous.pages + 1,
        };
      });
      setError(undefined);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingOlder(false);
    }
  };

  /** A post the Gateway answered with replaces the shown one; a withdrawn post leaves the list. */
  const replace = (post: BoardPostView): void =>
    setList((previous) => ({
      ...previous,
      posts:
        post.state === "withdrawn"
          ? previous.posts.filter((item) => item.id !== post.id)
          : previous.posts.map((item) => (item.id === post.id ? post : item)),
    }));

  return (
    <>
      <Composer
        api={api}
        workspaceId={workspaceId}
        onPosted={(post) =>
          setList((previous) => ({
            ...previous,
            posts: [post, ...previous.posts.filter((item) => item.id !== post.id)],
          }))
        }
      />
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      <ol className="board-posts" aria-label={t("board.list.label")} aria-busy={!loaded}>
        {list.posts.map((post) => (
          <BoardPost
            key={post.id}
            api={api}
            workspaceId={workspaceId}
            post={post}
            canModerate={list.canModerate}
            onChanged={replace}
          />
        ))}
      </ol>
      {!loaded ? (
        <p className="muted">{t("board.list.loading")}</p>
      ) : list.posts.length === 0 && !error ? (
        <p className="muted">{t("board.list.empty")}</p>
      ) : null}
      {list.nextCursor !== undefined ? (
        <Button
          variant="outline"
          type="button"
          disabled={loadingOlder}
          onClick={() => void loadOlder()}
        >
          {loadingOlder ? t("board.list.loadingOlder") : t("board.list.older")}
        </Button>
      ) : null}
    </>
  );
}

function Composer({
  api,
  workspaceId,
  onPosted,
}: {
  api: ApiClient;
  workspaceId: WorkspaceId;
  onPosted: (post: BoardPostView) => void;
}) {
  const t = useT();
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string>();
  // One key per draft: a retry after a lost answer reuses it, so the Gateway returns the first
  // post instead of making a second one. A new draft gets a new key.
  const requestId = useRef<string | undefined>(undefined);
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const text = body.trim();
    if (!text || posting) return;
    requestId.current ??= newRequestId();
    setPosting(true);
    setError(undefined);
    try {
      const post = await api.createBoardPost(workspaceId, {
        body: text,
        clientRequestId: requestId.current,
      });
      requestId.current = undefined;
      setBody("");
      onPosted(post);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPosting(false);
    }
  };
  return (
    <form className="board-composer card" onSubmit={submit}>
      <label htmlFor="board-composer-body">{t("board.composer.label")}</label>
      <textarea
        id="board-composer-body"
        className="board-textarea"
        value={body}
        placeholder={t("board.composer.placeholder")}
        disabled={posting}
        onChange={(event) => {
          setBody(event.target.value);
          // Editing the text makes it a different post; it must not reuse the old key.
          requestId.current = undefined;
        }}
        rows={3}
      />
      <p className="muted small" data-testid="board-audience">
        {t("board.composer.audience")}
      </p>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      <div className="board-actions">
        <Button variant="primary" type="submit" disabled={posting || body.trim() === ""}>
          {posting ? t("board.composer.posting") : t("board.composer.post")}
        </Button>
      </div>
    </form>
  );
}

function BoardPost({
  api,
  workspaceId,
  post,
  canModerate,
  onChanged,
}: {
  api: ApiClient;
  workspaceId: WorkspaceId;
  post: BoardPostView;
  canModerate: boolean;
  onChanged: (post: BoardPostView) => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(post.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [history, setHistory] = useState<BoardPostVersionView[]>();
  const hidden = post.state === "hidden";

  const act = async (action: () => Promise<BoardPostView>): Promise<boolean> => {
    setBusy(true);
    setError(undefined);
    try {
      onChanged(await action());
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const toggleHistory = async (): Promise<void> => {
    if (history) return setHistory(undefined);
    setBusy(true);
    setError(undefined);
    try {
      setHistory(await api.boardPostHistory(workspaceId, post.id));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      className={`board-post card${hidden ? " board-post-hidden" : ""}`}
      data-testid="board-post"
      data-state={post.state}
    >
      <div className="board-post-meta">
        <strong>{post.authorDisplayName}</strong>
        <span className="muted small">
          {formatDateTime(post.createdAt)}
          {post.version > 1 ? ` · ${t("board.post.edited")}` : ""}
        </span>
        {hidden ? <span className="board-post-flag small">{t("board.post.hidden")}</span> : null}
      </div>
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const text = draft.trim();
            if (!text) return;
            void act(() => api.editBoardPost(workspaceId, post.id, text)).then(
              (ok) => ok && setEditing(false),
            );
          }}
        >
          <textarea
            aria-label={t("board.post.editLabel")}
            className="board-textarea"
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            rows={3}
          />
          <div className="board-actions">
            <Button variant="primary" type="submit" disabled={busy || draft.trim() === ""}>
              {t("board.post.save")}
            </Button>
            <Button variant="ghost" type="button" disabled={busy} onClick={() => setEditing(false)}>
              {t("board.post.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        // Plain text only: React escapes it, and line breaks show through CSS.
        <p className="board-post-body">{post.body}</p>
      )}
      {error ? (
        <p role="alert" className="error small">
          {error}
        </p>
      ) : null}
      {editing ? null : (
        <div className="board-actions">
          {post.mine ? (
            <>
              <Button
                variant="ghost"
                type="button"
                disabled={busy}
                onClick={() => {
                  setDraft(post.body);
                  setEditing(true);
                }}
              >
                {t("board.post.edit")}
              </Button>
              <Button
                variant="ghost"
                type="button"
                disabled={busy}
                onClick={() => void act(() => api.withdrawBoardPost(workspaceId, post.id))}
              >
                {t("board.post.withdraw")}
              </Button>
            </>
          ) : null}
          {canModerate ? (
            <Button
              variant="ghost"
              type="button"
              disabled={busy}
              onClick={() =>
                void act(() => api.moderateBoardPost(workspaceId, post.id, { hidden: !hidden }))
              }
            >
              {hidden ? t("board.post.unhide") : t("board.post.hide")}
            </Button>
          ) : null}
          {post.mine || canModerate ? (
            <Button
              variant="ghost"
              type="button"
              disabled={busy}
              aria-expanded={history !== undefined}
              onClick={() => void toggleHistory()}
            >
              {history ? t("board.post.historyHide") : t("board.post.history")}
            </Button>
          ) : null}
        </div>
      )}
      {history ? (
        <ol className="board-history" aria-label={t("board.history.label")}>
          {history.map((version) => (
            <li key={version.version}>
              <span className="muted small">
                {t("board.history.entry", {
                  version: version.version,
                  op: t(OP_WORDS[version.op]),
                  at: formatDateTime(version.changedAt),
                })}
              </span>
              <p className="board-post-body">{version.body}</p>
            </li>
          ))}
        </ol>
      ) : null}
    </li>
  );
}
