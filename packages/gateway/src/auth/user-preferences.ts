// A person's own UI preferences (issue #22): the one JSON object in `users.preferences_json`.
// Reading keeps only the keys this Gateway knows, with the right type, so a value written by a
// newer release or by hand never reaches the UI malformed. A change names known keys only.

import {
  DeskmatesError,
  UI_LOCALES,
  type UpdatePreferencesRequest,
  type UserPreferences,
  isUiLocale,
} from "@deskmates/contracts";

const BOOLEAN_KEYS = ["firstRunChecklistDismissed"] as const satisfies ReadonlyArray<
  keyof UserPreferences
>;

/** Keys whose value is one of the operator UI locales (issue #23). */
const LOCALE_KEYS = ["locale"] as const satisfies ReadonlyArray<keyof UserPreferences>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The known preferences in a stored JSON object; anything else is left out. */
export function readPreferences(json: string): UserPreferences {
  let stored: unknown;
  try {
    stored = JSON.parse(json);
  } catch {
    return {};
  }
  if (!isRecord(stored)) return {};
  const preferences: UserPreferences = {};
  for (const key of BOOLEAN_KEYS)
    if (typeof stored[key] === "boolean") preferences[key] = stored[key];
  for (const key of LOCALE_KEYS) {
    const value = stored[key];
    if (isUiLocale(value)) preferences[key] = value;
  }
  return preferences;
}

/** A `PATCH /auth/preferences` body: at least one known key, each with its type. */
export function parsePreferencesChange(body: unknown): UpdatePreferencesRequest {
  if (!isRecord(body)) throw new DeskmatesError("validation", "preferences must be an object");
  const keys = Object.keys(body);
  if (keys.length === 0) throw new DeskmatesError("validation", "no preference to change");
  const change: UpdatePreferencesRequest = {};
  for (const key of keys) {
    const value = body[key];
    const locale = LOCALE_KEYS.find((candidate) => candidate === key);
    if (locale) {
      if (!isUiLocale(value))
        throw new DeskmatesError("validation", `${key} must be one of ${UI_LOCALES.join(", ")}`);
      change[locale] = value;
      continue;
    }
    const known = BOOLEAN_KEYS.find((candidate) => candidate === key);
    if (!known) throw new DeskmatesError("validation", `unknown preference ${key}`);
    if (typeof value !== "boolean")
      throw new DeskmatesError("validation", `${key} must be true or false`);
    change[known] = value;
  }
  return change;
}
