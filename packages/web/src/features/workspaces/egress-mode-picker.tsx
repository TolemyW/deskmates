// Where a workspace's bots may go (ADR-0020): the open public internet, the default, or only
// the sites on a list, where a first visit to any other site asks in the chat and "Allow this
// site" grows the list. Private addresses are never reachable either way.

import { useT } from "../../i18n/i18n-provider.js";

/** Example hostnames for the list: hostnames, the same in every language. */
const DOMAINS_EXAMPLE = "ops.example.test\n*.galaxy.example";

export function EgressModePicker({
  locked,
  domains,
  onLocked,
  onDomains,
  disabled,
}: {
  locked: boolean;
  domains: string;
  onLocked: (locked: boolean) => void;
  onDomains: (domains: string) => void;
  disabled?: boolean | undefined;
}) {
  const t = useT();
  return (
    <fieldset className="egress-mode" disabled={disabled}>
      <legend className="small">{t("egressModePicker.legend")}</legend>
      <label className="egress-mode-option">
        <input type="radio" name="egress-mode" checked={!locked} onChange={() => onLocked(false)} />
        <span>
          <strong>{t("egressModePicker.open.title")}</strong>
          <span className="muted small">{t("egressModePicker.open.body")}</span>
        </span>
      </label>
      <label className="egress-mode-option">
        <input type="radio" name="egress-mode" checked={locked} onChange={() => onLocked(true)} />
        <span>
          <strong>{t("egressModePicker.locked.title")}</strong>
          <span className="muted small">{t("egressModePicker.locked.body")}</span>
        </span>
      </label>
      {locked ? (
        <label>
          {t("egressModePicker.domains")}
          <textarea
            value={domains}
            onChange={(e) => onDomains(e.target.value)}
            rows={3}
            placeholder={DOMAINS_EXAMPLE}
          />
        </label>
      ) : null}
    </fieldset>
  );
}
