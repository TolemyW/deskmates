import { ArchiveX } from "lucide-react";
import { useT } from "../i18n/i18n-provider.js";

/** A terminal deep-link state: no retry button and no live editor that can mutate stale data. */
export function DeletedObjectState() {
  const t = useT();
  return (
    <section className="terminal-page deleted-object-state" data-testid="deleted-object">
      <ArchiveX size={32} aria-hidden="true" />
      <h2>{t("app.missing.object.title")}</h2>
      <p>{t("app.missing.object.body")}</p>
      <a className="button primary" href="#/threads">
        {t("app.missing.home")}
      </a>
    </section>
  );
}
