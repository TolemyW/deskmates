import { useState } from "react";
import { usePanelWidth } from "./panel-width.js";

/** Two stable stages; pointer hysteresis prevents jitter near the collapse boundary. */
export function useNavigationWidth() {
  const panel = usePanelWidth("navigation", 240, 200, (vw) => Math.min(320, vw - 620));
  const [preferredCompact, setCompact] = useState(() => {
    try {
      const mode = localStorage.getItem("deskmates.navigation.compact");
      if (mode !== null) return mode === "true";
      const old = Number(localStorage.getItem("deskmates.panel.navigation"));
      return old > 0 ? old < 180 : true;
    } catch {
      return true;
    }
  });
  const compact = preferredCompact;
  const mode = (next: boolean) => {
    setCompact(next);
    try {
      localStorage.setItem("deskmates.navigation.compact", String(next));
    } catch {
      /* Optional preference. */
    }
  };
  return {
    compact,
    toggle() {
      mode(!compact);
    },
    width: compact ? 64 : panel.width,
    min: 64,
    max: panel.max,
    setWidth(next: number, source?: "keyboard" | "pointer") {
      if (compact) {
        if ((source === "keyboard" && next > 64) || next >= 200) {
          mode(false);
          // Restore the expanded preference after leaving the icon stage.
          if (next > panel.width) panel.setWidth(next);
        }
      } else if (next < 180 || (source === "keyboard" && panel.width === 200 && next < 200))
        mode(true);
      else panel.setWidth(Math.max(200, next));
    },
  };
}
