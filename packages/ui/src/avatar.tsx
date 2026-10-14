import { useState } from "react";

const colors = ["accent", "success", "warning", "danger", "default"] as const;
export type AvatarColor = (typeof colors)[number];

function normalizeName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

/** Stable identity decoration, not a random value or a user status. */
export function getAvatarColor(name: string): AvatarColor {
  const normalized = normalizeName(name).toLowerCase();
  if (!normalized) return "default";
  let hash = 2166136261;
  for (const character of normalized) {
    hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 16777619);
  }
  return colors[(hash >>> 0) % colors.length] ?? "default";
}

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
function initials(name: string): string {
  const words = name.split(" ");
  const first = [...graphemes.segment(words[0] ?? "")];
  if (words.length === 1)
    return first
      .slice(0, 2)
      .map(({ segment }) => segment)
      .join("")
      .toUpperCase();
  const last = [...graphemes.segment(words.at(-1) ?? "")];
  return `${first[0]?.segment ?? ""}${last[0]?.segment ?? ""}`.toUpperCase();
}

export interface AvatarProps {
  name: string;
  size?: "sm" | "md" | "lg";
  className?: string;
  /**
   * An image to show instead of the initials, e.g. an uploaded photo. While it fails to load
   * (or when absent) the name-based fallback is shown. The consumer supplies a trusted URL.
   */
  src?: string | null;
}

/** Circular username fallback using HeroUI's paired soft background/foreground tokens. */
export function Avatar({ name, size = "md", className = "", src }: AvatarProps) {
  const label = normalizeName(name);
  const [failed, setFailed] = useState<string | null>(null);
  const image = src && failed !== src ? src : null;
  return (
    <span
      role="img"
      aria-label={label || "Unknown user"}
      data-gb-ui="avatar"
      data-color={getAvatarColor(name)}
      data-size={size}
      data-image={image ? "true" : undefined}
      className={`gb-avatar ${className}`}
    >
      {image ? (
        <img src={image} alt="" draggable={false} onError={() => setFailed(image)} />
      ) : label ? (
        initials(label)
      ) : (
        "?"
      )}
    </span>
  );
}
