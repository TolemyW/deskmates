// Keep a failure visible, with the exact error available on demand rather than a stack in chat.
import { useState } from "react";
import { describeRunError } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { useTuneView } from "../../lib/interface-view.js";

export function CompactRunError({ error }: { error: string }) {
  const t = useT();
  const tune = useTuneView();
  const [original, setOriginal] = useState(false);
  const known = describeRunError(error);
  const summary = known !== error ? known : t("chatPane.failure.failed");
  return (
    <>
      <p>{summary}</p>
      {tune ? (
        <button
          type="button"
          className="link-button small"
          data-chat-disclosure
          aria-expanded={original}
          onClick={() => setOriginal((value) => !value)}
        >
          {t("chatPane.history.original")}
        </button>
      ) : null}
      {tune && original ? <pre className="history-original">{error}</pre> : null}
    </>
  );
}
