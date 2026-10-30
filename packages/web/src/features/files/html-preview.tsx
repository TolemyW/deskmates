// Static HTML stays in an opaque offline frame. Inline styling is presentation, never authority.
import { useMemo, useState } from "react";
import { Button } from "../../components/ui/button.js";
import { useT } from "../../i18n/i18n-provider.js";

import { prepareHtmlPreview } from "./static-html.js";

export function HtmlPreview({ text, path }: { text: string; path: string }) {
  const t = useT();
  const prepared = useMemo(() => prepareHtmlPreview(text), [text]);
  const [desktop, setDesktop] = useState(false);
  return (
    <div className="html-preview">
      <div
        className="html-preview-controls"
        role="toolbar"
        aria-label={t("workspaceFilePreview.htmlViewport")}
      >
        <Button aria-pressed={!desktop} onClick={() => setDesktop(false)}>
          {t("workspaceFilePreview.htmlFit")}
        </Button>
        <Button aria-pressed={desktop} onClick={() => setDesktop(true)}>
          {t("workspaceFilePreview.htmlDesktop")}
        </Button>
      </div>
      <div className="html-preview-stage" data-desktop={desktop || undefined}>
        <iframe
          className="workspace-file-html"
          title={t("workspaceFilePreview.htmlLabel", { path })}
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={prepared.document}
        />
      </div>
      <p className="muted small html-preview-note">{t("workspaceFilePreview.htmlStatic")}</p>
      {prepared.links.length ? (
        <details className="html-preview-links">
          <summary>
            {t("workspaceFilePreview.htmlSources", { count: prepared.links.length })}
          </summary>
          <ul>
            {prepared.links.map((link) => (
              <li key={link.url}>
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  referrerPolicy="no-referrer"
                >
                  {link.label}
                </a>
                <span className="muted small">{new URL(link.url).hostname}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
