// Colour theme: light, dark, or follow the system. The choice is a per-browser convenience kept
// in localStorage; nothing about it reaches the Gateway. The attribute `data-theme` on <html>
// selects the token block in app.css.

import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "light" | "dark" | "system";

const KEY = "deskmates.theme";

export function loadThemePreference(): ThemePreference {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : false;
}

export function resolveTheme(preference: ThemePreference): "light" | "dark" {
  return preference === "system" ? (systemPrefersDark() ? "dark" : "light") : preference;
}

export function applyTheme(preference: ThemePreference): void {
  document.documentElement.setAttribute("data-theme", resolveTheme(preference));
}

export function useTheme(): {
  preference: ThemePreference;
  resolved: "light" | "dark";
  setPreference: (next: ThemePreference) => void;
  toggle: () => void;
} {
  const [preference, setPreferenceState] = useState<ThemePreference>(loadThemePreference);
  useEffect(() => {
    applyTheme(preference);
    if (preference !== "system" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    media.addEventListener?.("change", onChange);
    return () => media.removeEventListener?.("change", onChange);
  }, [preference]);
  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      if (next === "system") window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, next);
    } catch {
      // Storage disabled: the choice lasts for this page load.
    }
  }, []);
  const resolved = resolveTheme(preference);
  const toggle = useCallback(
    () => setPreference(resolved === "dark" ? "light" : "dark"),
    [resolved, setPreference],
  );
  return { preference, resolved, setPreference, toggle };
}
