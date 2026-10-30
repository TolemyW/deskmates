// A signed-in full-width reader reuses the bounded file API and the same offline HTML frame.
import type { WorkspaceId } from "@deskmates/contracts";
import { useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button, ButtonLink } from "../../components/ui/button.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { HtmlPreview } from "./html-preview.js";
import { downloadWorkspaceFile } from "./path-links.js";
import { filesHref } from "./route.js";
import { decodeText, readPreviewBytes } from "./workspace-file-preview.js";

export function HtmlReader({
  api,
  workspaceId,
  path,
}: { api: ApiClient; workspaceId: string; path: string }) {
  const t = useT();
  const [content, setContent] = useState<{ text: string; truncated: boolean }>();
  const [error, setError] = useState("");
  const [source, setSource] = useState(false);
  const [revision, setRevision] = useState(0);
  const supported = /\.(?:html?|xhtml)$/i.test(path);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the explicit retry trigger.
  useEffect(() => {
    const controller = new AbortController();
    setContent(undefined);
    setError("");
    setSource(false);
    if (!supported) {
      setError(t("workspaceFilePreview.unavailableType"));
      return () => controller.abort();
    }
    readPreviewBytes(api, workspaceId as WorkspaceId, path, 4 * 1024 * 1024, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted)
          setContent({ text: decodeText(value.bytes), truncated: value.truncated });
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(errorMessage(err));
      });
    return () => controller.abort();
  }, [api, workspaceId, path, t, revision, supported]);
  return (
    <section className="html-reader">
      <header className="html-reader-header">
        <div>
          <h1>{path.split("/").at(-1)}</h1>
          <p className="muted small">{t("workspaceFilePreview.readerSubtitle")}</p>
        </div>
        <ButtonLink href={filesHref({ workspaceId, path })}>
          {t("workspaceFilePreview.showFile")}
        </ButtonLink>
      </header>
      <div
        className="html-reader-toolbar"
        role="toolbar"
        aria-label={t("workspaceFilePreview.viewLabel")}
      >
        <Button disabled={!content} aria-pressed={!source} onClick={() => setSource(false)}>
          {t("workspaceFilePreview.viewRendered")}
        </Button>
        <Button disabled={!content} aria-pressed={source} onClick={() => setSource(true)}>
          {t("workspaceFilePreview.viewSource")}
        </Button>
        <Button
          onClick={() => {
            void downloadWorkspaceFile(api, workspaceId as WorkspaceId, path).catch((err) =>
              setError(errorMessage(err)),
            );
          }}
        >
          {t("workspaceFilePreview.download")}
        </Button>
      </div>
      {error ? <p role="alert">{t("files.reader.error", { error })}</p> : null}
      {error && !content && supported ? (
        <Button onClick={() => setRevision((value) => value + 1)}>{t("files.retry")}</Button>
      ) : null}
      {!content && !error ? <output>{t("workspaceFilePreview.loading")}</output> : null}
      {content?.truncated ? <p>{t("workspaceFilePreview.truncated")}</p> : null}
      {content ? (
        source ? (
          <pre className="html-reader-source">{content.text}</pre>
        ) : (
          <HtmlPreview text={content.text} path={path} />
        )
      ) : null}
    </section>
  );
}
