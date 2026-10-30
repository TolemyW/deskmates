// The network profile editor: one row per target (host or subnet, schemes, ports), expiry as a
// choice (never, a day, a week, a moment), and an advanced switch that edits the same rules as
// JSON for whoever prefers to paste. Both views feed `parseNetworkRules`, the Gateway's own
// validation, so a mistake is named here before a request is made. The pure helpers are exported
// for the tests.

import {
  DeskmatesError,
  type NetworkProfile,
  type NetworkRule,
  parseNetworkRules,
} from "@deskmates/contracts";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";

export type ExpiryMode = "never" | "day" | "week" | "at";

export interface RuleDraft {
  key: string;
  kind: "host" | "subnet";
  hostname: string;
  address: string;
  cidr: string;
  http: boolean;
  https: boolean;
  /** Comma- or space-separated port numbers as typed. */
  ports: string;
}

export interface ProfileDraft {
  id?: string;
  revision?: number;
  name: string;
  description: string;
  expiry: { mode: ExpiryMode; at: string };
  rules: RuleDraft[];
}

let keyCounter = 0;
const nextKey = () => `r${++keyCounter}`;

export function emptyRule(): RuleDraft {
  return {
    key: nextKey(),
    kind: "subnet",
    hostname: "",
    address: "",
    cidr: "",
    http: true,
    https: false,
    ports: "",
  };
}

export function ruleDraftOf(rule: NetworkRule): RuleDraft {
  return {
    key: nextKey(),
    kind: rule.kind,
    hostname: rule.kind === "host" ? rule.hostname : "",
    address: rule.kind === "host" ? rule.address : "",
    cidr: rule.kind === "subnet" ? rule.cidr : "",
    http: rule.schemes.includes("http"),
    https: rule.schemes.includes("https"),
    ports: rule.ports.join(", "),
  };
}

/** An ISO instant as a `datetime-local` value in this browser's zone, minute precision. */
export function toLocalInput(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A `datetime-local` value as an ISO instant; an empty or unreadable one is undefined. */
export function fromLocalInput(local: string): string | undefined {
  if (local.trim() === "") return undefined;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function draftOf(profile?: NetworkProfile): ProfileDraft {
  if (!profile) {
    return {
      name: "",
      description: "",
      expiry: { mode: "never", at: "" },
      rules: [emptyRule()],
    };
  }
  return {
    id: profile.id,
    revision: profile.revision,
    name: profile.name,
    description: profile.description,
    expiry: profile.expiresAt
      ? { mode: "at", at: toLocalInput(profile.expiresAt) }
      : { mode: "never", at: "" },
    rules: profile.rules.map(ruleDraftOf),
  };
}

/** The rows as rules, as typed: the Gateway's parser judges them. */
export function rawRulesOf(rules: readonly RuleDraft[]): unknown[] {
  return rules.map((r) => {
    const schemes = [...(r.http ? ["http"] : []), ...(r.https ? ["https"] : [])];
    const ports = r.ports
      .split(/[\s,;]+/)
      .filter((p) => p !== "")
      .map((p) => (/^\d+$/.test(p) ? Number(p) : p));
    return r.kind === "host"
      ? { kind: "host", hostname: r.hostname.trim(), address: r.address.trim(), schemes, ports }
      : { kind: "subnet", cidr: r.cidr.trim(), schemes, ports };
  });
}

/** When a profile saved now with this choice expires; undefined means never. */
export function expiresAtOf(expiry: ProfileDraft["expiry"], now = Date.now()): string | undefined {
  switch (expiry.mode) {
    case "never":
      return undefined;
    case "day":
      return new Date(now + 24 * 3_600_000).toISOString();
    case "week":
      return new Date(now + 7 * 24 * 3_600_000).toISOString();
    case "at":
      return fromLocalInput(expiry.at);
  }
}

export interface ProfileInput {
  name: string;
  description: string;
  rules: NetworkRule[];
  expiresAt?: string;
}

/** What the form submits; throws the Gateway's own validation message on a bad rule. */
export function inputOf(
  draft: ProfileDraft,
  json: string | undefined,
  now = Date.now(),
): ProfileInput {
  let raw: unknown;
  if (json !== undefined) {
    try {
      raw = JSON.parse(json);
    } catch (err) {
      throw new DeskmatesError("validation", errorMessage(err));
    }
  } else raw = rawRulesOf(draft.rules);
  const rules = parseNetworkRules(raw);
  const expiresAt = expiresAtOf(draft.expiry, now);
  if (draft.expiry.mode === "at" && expiresAt === undefined)
    throw new DeskmatesError("validation", "expiry needs a date and time");
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    rules,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

export function ProfileForm(props: {
  draft: ProfileDraft;
  busy: boolean;
  onChange: (draft: ProfileDraft) => void;
  onSave: (input: ProfileInput) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const { draft, onChange } = props;
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameInput.current?.focus();
  }, []);
  /** The JSON text while the advanced view is on; undefined in the structured view. */
  const [json, setJson] = useState<string>();
  const [problem, setProblem] = useState<string>();

  const setRule = (key: string, patch: Partial<RuleDraft>) =>
    onChange({
      ...draft,
      rules: draft.rules.map((r) => (r.key === key ? { ...r, ...patch } : r)),
    });

  const toggleAdvanced = () => {
    setProblem(undefined);
    if (json === undefined) {
      setJson(JSON.stringify(rawRulesOf(draft.rules), null, 2));
      return;
    }
    try {
      const parsed: unknown = JSON.parse(json);
      if (!Array.isArray(parsed)) throw new Error(t("network.form.jsonList"));
      onChange({ ...draft, rules: parsed.map((r) => ruleDraftOf(looseRule(r))) });
      setJson(undefined);
    } catch (err) {
      setProblem(t("network.form.jsonInvalid", { error: errorMessage(err) }));
    }
  };

  const submit = () => {
    if (props.busy) return;
    setProblem(undefined);
    try {
      props.onSave(inputOf(draft, json));
    } catch (err) {
      setProblem(errorMessage(err));
    }
  };

  return (
    <form
      className="network-form card"
      aria-label={draft.id === undefined ? t("network.form.new") : t("network.form.edit")}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h3>{draft.id === undefined ? t("network.form.new") : t("network.form.edit")}</h3>
      <label>
        {t("network.name")}
        <input
          ref={nameInput}
          disabled={props.busy}
          value={draft.name}
          required
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
        />
      </label>
      <label>
        {t("network.description")}
        <input
          disabled={props.busy}
          value={draft.description}
          onChange={(e) => onChange({ ...draft, description: e.target.value })}
        />
      </label>
      <fieldset className="network-expiry-choice" disabled={props.busy}>
        <legend>{t("network.form.expires")}</legend>
        {(["never", "day", "week", "at"] as const).map((mode) => (
          <label key={mode} className="network-radio">
            <input
              type="radio"
              name="network-expiry"
              checked={draft.expiry.mode === mode}
              onChange={() => onChange({ ...draft, expiry: { ...draft.expiry, mode } })}
            />
            {t(`network.form.expiry.${mode}`)}
          </label>
        ))}
        {draft.expiry.mode === "at" ? (
          <input
            type="datetime-local"
            aria-label={t("network.form.expiryAt")}
            value={draft.expiry.at}
            onChange={(e) => onChange({ ...draft, expiry: { mode: "at", at: e.target.value } })}
          />
        ) : null}
      </fieldset>
      <fieldset className="network-targets" disabled={props.busy}>
        <legend>
          {t("network.form.targets")}
          <button
            type="button"
            className="network-link"
            disabled={props.busy}
            onClick={toggleAdvanced}
          >
            {json === undefined ? t("network.form.advancedOn") : t("network.form.advancedOff")}
          </button>
        </legend>
        {json !== undefined ? (
          <textarea
            aria-label={t("network.form.json")}
            rows={10}
            value={json}
            onChange={(e) => setJson(e.target.value)}
          />
        ) : (
          <>
            {draft.rules.map((rule, index) => (
              <div key={rule.key} className="network-target-row">
                <select
                  aria-label={t("network.form.kind")}
                  value={rule.kind}
                  onChange={(e) => setRule(rule.key, { kind: e.target.value as RuleDraft["kind"] })}
                >
                  <option value="subnet">{t("network.form.kind.subnet")}</option>
                  <option value="host">{t("network.form.kind.host")}</option>
                </select>
                {rule.kind === "subnet" ? (
                  <input
                    aria-label={t("network.form.cidr")}
                    placeholder="10.88.30.0/24"
                    value={rule.cidr}
                    onChange={(e) => setRule(rule.key, { cidr: e.target.value })}
                  />
                ) : (
                  <>
                    <input
                      aria-label={t("network.form.hostname")}
                      value={rule.hostname}
                      onChange={(e) => setRule(rule.key, { hostname: e.target.value })}
                    />
                    <input
                      aria-label={t("network.form.address")}
                      placeholder="10.88.30.5"
                      value={rule.address}
                      onChange={(e) => setRule(rule.key, { address: e.target.value })}
                    />
                  </>
                )}
                <label className="network-scheme">
                  <input
                    type="checkbox"
                    checked={rule.http}
                    onChange={(e) => setRule(rule.key, { http: e.target.checked })}
                  />
                  http
                </label>
                <label className="network-scheme">
                  <input
                    type="checkbox"
                    checked={rule.https}
                    onChange={(e) => setRule(rule.key, { https: e.target.checked })}
                  />
                  https
                </label>
                <input
                  aria-label={t("network.form.ports")}
                  placeholder="8080, 8443"
                  value={rule.ports}
                  onChange={(e) => setRule(rule.key, { ports: e.target.value })}
                />
                <button
                  type="button"
                  className="network-link"
                  aria-label={t("network.form.removeTarget", { n: index + 1 })}
                  disabled={draft.rules.length === 1}
                  onClick={() =>
                    onChange({ ...draft, rules: draft.rules.filter((r) => r.key !== rule.key) })
                  }
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              type="button"
              className="network-link"
              onClick={() => onChange({ ...draft, rules: [...draft.rules, emptyRule()] })}
            >
              {t("network.form.addTarget")}
            </button>
          </>
        )}
      </fieldset>
      {problem ? (
        <p className="error" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="network-form-actions">
        <Button type="button" variant="ghost" disabled={props.busy} onClick={props.onCancel}>
          {t("network.cancel")}
        </Button>
        <Button type="submit" disabled={props.busy}>
          {t("network.save")}
        </Button>
      </div>
    </form>
  );
}

/** A pasted rule as rows can show it, whatever is missing; the parser judges it on save. */
function looseRule(value: unknown): NetworkRule {
  const r = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const schemes = Array.isArray(r.schemes)
    ? (r.schemes.filter((s) => s === "http" || s === "https") as NetworkRule["schemes"])
    : [];
  const ports = Array.isArray(r.ports) ? r.ports.filter((p) => typeof p === "number") : [];
  if (r.kind === "host")
    return {
      kind: "host",
      hostname: typeof r.hostname === "string" ? r.hostname : "",
      address: typeof r.address === "string" ? r.address : "",
      schemes,
      ports,
    };
  return { kind: "subnet", cidr: typeof r.cidr === "string" ? r.cidr : "", schemes, ports };
}
