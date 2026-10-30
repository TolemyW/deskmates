// A channel method's setup guide (ADR-0047 amendment 2): numbered plain-text steps with official
// links and copyable non-secret values, help per config field, and a link that opens the verified
// account. Release-bundled with the plugin; the Gateway validates it at load and passes it through.

/** One step a person follows on the provider's side. Plain text, never Markdown or HTML (G1). */
export interface ChannelSetupStep {
  /** Stable within its method; the Web translates `<plugin>.<method>.<id>` (G4). */
  id: string;
  text: string;
  /** A provider page, opened in a new tab without opener or referrer. */
  link?: { label: string; url: string };
  /** A non-secret value the person pastes on the provider; `{webhookPath}` is the only placeholder. */
  copy?: { label: string; value: string };
}

export interface ChannelSetupGuide {
  steps: readonly ChannelSetupStep[];
}

/** G3: a link to the verified account, as a template over the identity. */
export interface ChannelOpenLink {
  label: string;
  /** `https:` URL; placeholders `{namespace}`, `{id}`, `{handle}` only. */
  url: string;
}

export const CHANNEL_SETUP_STEPS_MAX = 12;
export const CHANNEL_SETUP_TEXT_MAX = 400;
export const CHANNEL_SETUP_COPY_MAX = 4_000;
export const CHANNEL_FIELD_HELP_MAX = 300;
/** The placeholder a copy value may hold; the Web replaces it with the connection's webhook path. */
export const CHANNEL_WEBHOOK_PATH_PLACEHOLDER = "{webhookPath}";

const STEP_ID = /^[a-z0-9-]{1,32}$/;
const OPEN_PLACEHOLDERS = new Set(["{namespace}", "{id}", "{handle}"]);
const COPY_PLACEHOLDERS = new Set([CHANNEL_WEBHOOK_PATH_PLACEHOLDER]);
const HANDLE = /^[A-Za-z0-9_.]{1,64}$/;

const isText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;

/** An absolute `https:` URL once its placeholders are filled with a harmless value. */
function isHttpsTemplate(value: unknown, placeholders: ReadonlySet<string>): value is string {
  if (typeof value !== "string" || value.length > 2_000) return false;
  if (!placeholdersWithin(value, placeholders)) return false;
  try {
    return new URL(value.replace(/\{[a-z]+\}/gi, "x")).protocol === "https:";
  } catch {
    return false;
  }
}

function placeholdersWithin(value: string, allowed: ReadonlySet<string>): boolean {
  return (value.match(/\{[A-Za-z][A-Za-z0-9_]*\}/g) ?? []).every((placeholder) =>
    allowed.has(placeholder),
  );
}

/**
 * Why a method's guide, field help or open link breaks amendment 2, or nothing (G5). `method` is
 * the raw manifest entry, so every shape is checked rather than trusted.
 */
export function channelSetupProblems(method: unknown): string[] {
  if (!method || typeof method !== "object") return [];
  const m = method as {
    id?: unknown;
    setup?: unknown;
    open?: unknown;
    fields?: unknown;
  };
  const name = `method ${String(m.id)}`;
  const problems: string[] = [];
  if (m.setup !== undefined) {
    const steps = (m.setup as { steps?: unknown } | null)?.steps;
    if (!Array.isArray(steps) || steps.length === 0) problems.push(`${name} setup must have steps`);
    else {
      if (steps.length > CHANNEL_SETUP_STEPS_MAX)
        problems.push(`${name} setup has more than ${CHANNEL_SETUP_STEPS_MAX} steps`);
      const seen = new Set<string>();
      for (const raw of steps as Partial<Record<keyof ChannelSetupStep, unknown>>[]) {
        const id = typeof raw?.id === "string" ? raw.id : "";
        if (!STEP_ID.test(id)) problems.push(`${name} step id ${String(raw?.id)} is invalid`);
        else if (seen.has(id)) problems.push(`${name} step id ${id} is repeated`);
        seen.add(id);
        if (!isText(raw?.text, CHANNEL_SETUP_TEXT_MAX))
          problems.push(
            `${name} step ${id} text must be 1 to ${CHANNEL_SETUP_TEXT_MAX} characters`,
          );
        if (raw?.link !== undefined) {
          const link = raw.link as { label?: unknown; url?: unknown } | null;
          if (!isText(link?.label, 80) || !isHttpsTemplate(link?.url, new Set()))
            problems.push(`${name} step ${id} link must have a label and an https URL`);
        }
        if (raw?.copy !== undefined) {
          const copy = raw.copy as { label?: unknown; value?: unknown } | null;
          if (
            !isText(copy?.label, 80) ||
            !isText(copy?.value, CHANNEL_SETUP_COPY_MAX) ||
            !placeholdersWithin(copy.value, COPY_PLACEHOLDERS)
          )
            problems.push(`${name} step ${id} copy must have a label and a value without secrets`);
        }
      }
    }
  }
  if (m.open !== undefined) {
    const open = m.open as { label?: unknown; url?: unknown } | null;
    if (!isText(open?.label, 80) || !isHttpsTemplate(open?.url, OPEN_PLACEHOLDERS))
      problems.push(`${name} open must have a label and an https URL with known placeholders`);
  }
  if (Array.isArray(m.fields))
    for (const field of m.fields as { key?: unknown; help?: unknown }[])
      if (field?.help !== undefined && !isText(field.help, CHANNEL_FIELD_HELP_MAX))
        problems.push(
          `${name} field ${String(field.key)} help must be 1 to ${CHANNEL_FIELD_HELP_MAX} characters`,
        );
  return problems;
}

/**
 * The open link for a verified identity (G3), or undefined when the identity is pending, the key
 * is malformed, or the template needs a handle the label does not give.
 */
export function channelOpenUrl(
  template: string,
  identity: { identityKey?: string | undefined; label?: string | undefined },
): string | undefined {
  const parts = identity.identityKey?.split(":") ?? [];
  if (parts.length < 3) return undefined;
  const [, namespace = "", ...rest] = parts;
  if (namespace === "pending") return undefined;
  const handle = identity.label?.trim().replace(/^[@+]/, "") ?? "";
  const values: Record<string, string | undefined> = {
    "{namespace}": namespace,
    "{id}": rest.join(":"),
    "{handle}": HANDLE.test(handle) ? handle : undefined,
  };
  let missing = false;
  const url = template.replace(/\{[a-z]+\}/g, (placeholder) => {
    const value = values[placeholder];
    if (!value) missing = true;
    return encodeURIComponent(value ?? "");
  });
  if (missing) return undefined;
  try {
    return new URL(url).protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}
