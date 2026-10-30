import type {
  ChannelMenuCommand,
  ChannelMenuRequest,
  ChannelMenuResult,
  WorkspaceId,
} from "@deskmates/contracts";
import { useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";

export function ChannelMenu({
  api,
  workspaceId,
  connectionId,
  commands,
}: {
  api: ApiClient;
  workspaceId: WorkspaceId;
  connectionId: string;
  commands: readonly ChannelMenuCommand[];
}) {
  const t = useT();
  const [scope, setScope] = useState<ChannelMenuRequest["scope"]>("default");
  const [chatId, setChatId] = useState("");
  const [language, setLanguage] = useState("");
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ChannelMenuResult>();
  const [error, setError] = useState("");
  const change = () => {
    setResult(undefined);
    setError("");
  };
  const run = async (operation: ChannelMenuRequest["operation"]) => {
    setBusy(true);
    setError("");
    setResult(undefined);
    try {
      setResult(
        await api.channelCommandMenu(workspaceId, connectionId, {
          operation,
          scope,
          ...(scope === "chat" ? { chatId: chatId.trim() } : {}),
          languageCode: language.trim(),
          replaceMenuButton: replace,
        }),
      );
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  const invalid =
    !/^(?:[a-z]{2})?$/.test(language.trim()) ||
    (scope === "chat" && !/^[1-9][0-9]{0,15}$/.test(chatId.trim()));
  return (
    <details className="channel-connection-section">
      <summary>{t("integrations.channels.menu.title")}</summary>
      <div className="stack">
        <p className="small muted">{t("integrations.channels.menu.explain")}</p>
        <p>{t("integrations.channels.menu.proposed")}</p>
        <ul>
          {commands.map((item) => (
            <li key={item.command}>
              <code>/{item.command}</code> — {item.description}
            </li>
          ))}
        </ul>
        <label>
          {t("integrations.channels.menu.scope")}
          <select
            disabled={busy}
            value={scope}
            onChange={(e) => {
              setScope(e.target.value as ChannelMenuRequest["scope"]);
              change();
            }}
          >
            <option value="default">{t("integrations.channels.menu.default")}</option>
            <option value="private">{t("integrations.channels.menu.private")}</option>
            <option value="chat">{t("integrations.channels.menu.chat")}</option>
          </select>
        </label>
        {scope === "chat" ? (
          <label>
            {t("integrations.channels.menu.chatId")}
            <input
              disabled={busy}
              value={chatId}
              onChange={(e) => {
                setChatId(e.target.value);
                change();
              }}
            />
          </label>
        ) : null}
        <label>
          {t("integrations.channels.menu.language")}
          <input
            disabled={busy}
            maxLength={2}
            value={language}
            onChange={(e) => {
              setLanguage(e.target.value);
              change();
            }}
          />
        </label>
        <label>
          <input
            type="checkbox"
            disabled={busy}
            checked={replace}
            onChange={(e) => {
              setReplace(e.target.checked);
              change();
            }}
          />{" "}
          {t("integrations.channels.menu.replace")}
        </label>
        <div className="integration-card-actions">
          <Button variant="outline" disabled={busy || invalid} onClick={() => void run("inspect")}>
            {t("integrations.channels.menu.inspect")}
          </Button>
          <Button disabled={busy || invalid} onClick={() => void run("sync")}>
            {t("integrations.channels.menu.sync")}
          </Button>
        </div>
        {error ? <p role="alert">{error}</p> : null}
        {result ? (
          <output className="small">
            <p>{t("integrations.channels.menu.current", { button: result.menuButton })}</p>
            <ul>
              {result.commands.map((item) => (
                <li key={item.command}>
                  <code>/{item.command}</code> — {item.description}
                </li>
              ))}
            </ul>
          </output>
        ) : null}
      </div>
    </details>
  );
}
