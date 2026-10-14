// The sidebar's top block: the current workspace. With one workspace it is a label; with more
// it is a compact menu (ADR-0034 decision 8): the current workspace, a server search, up to five
// pinned and five recently active workspaces, then "Manage all workspaces", Trash and New. It
// never renders the whole list; the Workspaces page of User Settings does that, 20 at a time.

import {
  type WorkspaceDirectoryEntry,
  type WorkspaceId,
  isOpenInternetAllowlist,
} from "@deskmates/contracts";
import { BrandMark } from "@deskmates/ui";
import { Check, ChevronsUpDown, Globe, Pin, Plus, Search, Settings2 } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/i18n-provider.js";
import { trashHref } from "../../router.js";
import { useCan } from "../../state/session-roles.js";
import type { WorkspaceScope } from "../../state/workspace-scope.js";
import { workspacesHref } from "../account/route.js";
import type { WorkspacesApi } from "./api.js";

/** How many pinned, recent and search rows the menu shows at most. */
export const SWITCHER_PINNED = 5;
export const SWITCHER_RECENT = 5;
export const SWITCHER_SEARCH = 8;
const SEARCH_DELAY_MS = 200;

interface Row {
  id: WorkspaceId;
  name: string;
  openInternet: boolean;
  domains?: number;
}

function fromEntry(entry: WorkspaceDirectoryEntry): Row {
  return { id: entry.id, name: entry.name, openInternet: entry.openInternet };
}

type Directory = Pick<WorkspacesApi, "listWorkspaceDirectory">;

/** A labelled group of menu items inside the menu. */
function MenuGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of menu items, not a form fieldset.
    <div role="group" aria-label={label}>
      {children}
    </div>
  );
}

/** Pinned and recent rows from the directory, read when the menu opens. */
function useMenuLists(directory: Directory | undefined, open: boolean) {
  const [lists, setLists] = useState<{ pinned: Row[]; recent: Row[] }>();
  useEffect(() => {
    if (!open || !directory) return;
    let active = true;
    const pinned = directory
      .listWorkspaceDirectory({ filter: "pinned", limit: SWITCHER_PINNED })
      .then((page) => page.workspaces.map(fromEntry))
      // A principal with no pins (or an older Gateway) shows no pinned group.
      .catch(() => [] as Row[]);
    const recent = directory
      .listWorkspaceDirectory({ limit: SWITCHER_RECENT + SWITCHER_PINNED + 1 })
      .then((page) => page.workspaces.map(fromEntry));
    Promise.all([pinned, recent])
      .then(([p, r]) => {
        if (!active || !Array.isArray(p) || !Array.isArray(r)) return;
        setLists({ pinned: p, recent: r });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [directory, open]);
  return lists;
}

/** Server search, debounced; only the latest answer is applied. */
function useSearch(directory: Directory | undefined, text: string) {
  const [result, setResult] = useState<{ q: string; rows: Row[] } | { q: string; error: true }>();
  const sequence = useRef(0);
  useEffect(() => {
    const q = text.trim();
    const request = ++sequence.current;
    if (!q || !directory) {
      setResult(undefined);
      return;
    }
    const timer = setTimeout(() => {
      directory
        .listWorkspaceDirectory({ q, limit: SWITCHER_SEARCH })
        .then((page) => {
          if (request === sequence.current)
            setResult({ q, rows: (page.workspaces ?? []).map(fromEntry) });
        })
        .catch(() => {
          if (request === sequence.current) setResult({ q, error: true });
        });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [directory, text]);
  return result;
}

export function WorkspaceSwitcher({
  scope,
  directory: directoryProp,
}: {
  scope: WorkspaceScope;
  /**
   * The directory client, by default the scope's; without one the menu shows the first few
   * workspaces it already has and no search.
   */
  directory?: Directory;
}) {
  const directory = directoryProp ?? scope.directory;
  const t = useT();
  const canViewTrash = useCan("trash.view").allowed;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const { workspaces, current } = scope;
  const lists = useMenuLists(directory, open);
  const search = useSearch(directory, text);

  useEffect(() => {
    if (!open) {
      setText("");
      return;
    }
    const menuItems = () =>
      Array.from(
        root.current?.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]') ??
          [],
      );
    if (searchBox.current) searchBox.current.focus();
    else menuItems()[0]?.focus();
    const onPointer = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      } else if (
        ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) &&
        root.current?.contains(document.activeElement) &&
        !(document.activeElement === searchBox.current && ["Home", "End"].includes(event.key))
      ) {
        event.preventDefault();
        const items = menuItems();
        const index = items.indexOf(document.activeElement as HTMLElement);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : index < 0
                ? event.key === "ArrowDown"
                  ? 0
                  : items.length - 1
                : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const known = (id: WorkspaceId) => workspaces.find((w) => w.id === id);
  const rowOf = (w: (typeof workspaces)[number]): Row => ({
    id: w.id,
    name: w.name,
    openInternet: isOpenInternetAllowlist(w.egressAllowlist),
    domains: w.egressAllowlist.length,
  });
  const notCurrent = (row: Row) => row.id !== current?.id;
  const pinned = (lists?.pinned ?? []).filter(notCurrent).slice(0, SWITCHER_PINNED);
  const pinnedIds = new Set(pinned.map((row) => row.id));
  // Until the directory answers (or without one), the first few workspaces already loaded.
  const recent = (lists ? lists.recent : workspaces.slice(0, SWITCHER_RECENT + 1).map(rowOf))
    .filter((row) => notCurrent(row) && !pinnedIds.has(row.id))
    .slice(0, SWITCHER_RECENT);
  const searching = text.trim() !== "";

  const choose = (row: Row) => {
    scope.select(row.id);
    setOpen(false);
  };
  const item = (row: Row, checked: boolean, prefix: string) => {
    const full = known(row.id) ? rowOf(known(row.id) as (typeof workspaces)[number]) : row;
    return (
      <button
        key={`${prefix}:${row.id}`}
        type="button"
        role="menuitemradio"
        aria-checked={checked}
        className="workspace-menu-item"
        title={row.name}
        onClick={() => choose(row)}
      >
        <span className="workspace-menu-name">{row.name}</span>
        <span className="muted small">
          {full.openInternet ? (
            <>
              <Globe size={11} /> {t("workspaceSwitcher.openInternet")}
            </>
          ) : full.domains !== undefined ? (
            t("workspaceSwitcher.allowedDomains", { count: full.domains })
          ) : (
            t("workspaceSwitcher.restricted")
          )}
        </span>
        {checked ? <Check size={15} aria-hidden="true" /> : null}
      </button>
    );
  };

  const name = current?.name ?? (scope.loaded ? t("workspaceSwitcher.noWorkspace") : "Deskmates");
  return (
    <div className={`workspace-switcher${open ? " open" : ""}`} ref={root}>
      <button
        type="button"
        className="brand"
        ref={trigger}
        title={name}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("workspaceSwitcher.buttonLabel", { name })}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="brand-mark">
          <BrandMark size={20} />
        </span>
        <span className="brand-text">
          <span className="brand-name">{name}</span>
          <span className="brand-caption">{t("workspaceSwitcher.caption")}</span>
        </span>
        <ChevronsUpDown size={15} className="brand-chevron" aria-hidden="true" />
      </button>
      {open ? (
        <div className="workspace-menu">
          <p className="workspace-menu-hint muted small">{t("workspaceSwitcher.hint")}</p>
          {directory ? (
            <label className="workspace-menu-search">
              <Search size={14} aria-hidden="true" />
              <input
                ref={searchBox}
                type="search"
                value={text}
                onChange={(event) => setText(event.target.value)}
                aria-label={t("workspaceSwitcher.searchLabel")}
                placeholder={t("workspaceSwitcher.searchPlaceholder")}
                maxLength={64}
              />
            </label>
          ) : null}
          <div role="menu" aria-label={t("workspaceSwitcher.menuLabel")}>
            {searching ? (
              <MenuGroup label={t("workspaceSwitcher.results")}>
                {search === undefined || search.q !== text.trim() ? (
                  <p className="workspace-menu-hint muted small">
                    {t("workspaceSwitcher.searching")}
                  </p>
                ) : "error" in search ? (
                  <p className="workspace-menu-hint error small">
                    {t("workspaceSwitcher.searchFailed")}
                  </p>
                ) : search.rows.length === 0 ? (
                  <p className="workspace-menu-hint muted small">
                    {t("workspaceSwitcher.noMatches")}
                  </p>
                ) : (
                  search.rows.map((row) => item(row, row.id === current?.id, "search"))
                )}
              </MenuGroup>
            ) : (
              <>
                {current ? item(rowOf(current), true, "current") : null}
                {pinned.length > 0 ? (
                  <MenuGroup label={t("workspaceSwitcher.pinned")}>
                    <p className="workspace-menu-group muted small" aria-hidden="true">
                      <Pin size={11} /> {t("workspaceSwitcher.pinned")}
                    </p>
                    {pinned.map((row) => item(row, false, "pinned"))}
                  </MenuGroup>
                ) : null}
                {recent.length > 0 ? (
                  <MenuGroup label={t("workspaceSwitcher.recent")}>
                    <p className="workspace-menu-group muted small" aria-hidden="true">
                      {t("workspaceSwitcher.recent")}
                    </p>
                    {recent.map((row) => item(row, false, "recent"))}
                  </MenuGroup>
                ) : null}
              </>
            )}
            <a
              role="menuitem"
              className="workspace-menu-item"
              href={workspacesHref()}
              onClick={() => setOpen(false)}
            >
              <Settings2 size={15} aria-hidden="true" /> {t("workspaceSwitcher.manageAll")}
            </a>
            {canViewTrash ? (
              <a
                role="menuitem"
                className="workspace-menu-item"
                href={trashHref()}
                onClick={() => setOpen(false)}
              >
                {t("workspaceTrash.title")}
              </a>
            ) : null}
            <button
              type="button"
              role="menuitem"
              className="workspace-menu-item new"
              onClick={() => {
                setOpen(false);
                scope.openCreate();
              }}
            >
              <Plus size={15} /> {t("workspaceSwitcher.new")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
