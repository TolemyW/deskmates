import { useEffect, useState } from "react";

/** Preference survives viewport changes; only the rendered width is clamped. */
export function usePanelWidth(
  key: string,
  fallback: number,
  min: number,
  maximum: (viewport: number) => number,
) {
  const [viewport, setViewport] = useState(() => window.innerWidth);
  const [preferred, setPreferred] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(`deskmates.panel.${key}`));
      return saved >= min && Number.isFinite(saved) ? saved : fallback;
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const max = Math.max(min, maximum(viewport));
  const width = Math.max(min, Math.min(preferred, max));
  const setWidth = (next: number) => {
    const value = Math.max(min, Math.min(next, max));
    setPreferred(value);
    try {
      localStorage.setItem(`deskmates.panel.${key}`, String(value));
    } catch {
      /* Optional preference. */
    }
  };
  return { width, min, max, setWidth };
}
