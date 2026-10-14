// A bot's avatar: the operator's emoji on a named colour when one is set, otherwise initials on
// a hue derived from the name, so a bot keeps one look everywhere it appears (rail, transcript,
// members, desktops). The choice comes from the bot row through the avatars registry.

import type { BotAvatar } from "@deskmates/contracts";
import { getAvatarColor } from "@deskmates/ui";
import { useT } from "../../i18n/i18n-provider.js";

import { cn } from "../../lib/utils.js";
import { useAvatarLookup } from "../../state/bot-avatars.js";

export type AvatarKind = "bot" | "human" | "system";

/** 1..8, stable for a name. */
export function avatarHue(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return (Math.abs(hash) % 8) + 1;
}

export function initials(name: string): string {
  const parts = name
    .trim()
    .split(/[\s_\-.]+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0] as string).slice(0, 2);
  return `${(parts[0] as string)[0] ?? ""}${(parts[1] as string)[0] ?? ""}`;
}

export function Avatar({
  name,
  avatar,
  kind = "bot",
  size,
  className,
  title,
}: {
  name: string;
  /** Overrides the registry; pass it where the bot row is at hand (profile, pickers). */
  avatar?: BotAvatar | undefined;
  kind?: AvatarKind;
  size?: "sm" | "lg" | "xl";
  className?: string;
  title?: string;
}) {
  const lookup = useAvatarLookup();
  const t = useT();
  const chosen = kind === "bot" ? (avatar ?? lookup(name)) : undefined;
  const emoji = chosen?.emoji;
  return (
    <span
      className={cn("avatar", kind, size, emoji ? "emoji" : undefined, className)}
      data-hue={kind === "bot" && !chosen?.color ? avatarHue(name) : undefined}
      data-color={chosen?.color}
      data-fallback-color={!chosen?.color ? getAvatarColor(name) : undefined}
      aria-hidden="true"
      title={title ?? name}
    >
      {kind === "human" ? (
        t("avatar.you")
      ) : kind === "system" ? (
        "!"
      ) : emoji ? (
        <span className="avatar-glyph">{emoji}</span>
      ) : (
        initials(name)
      )}
    </span>
  );
}

/** Up to `max` avatars overlapping, then a "+n" count. */
export function AvatarStack({ names, max = 3 }: { names: readonly string[]; max?: number }) {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  return (
    <span className="avatar-stack">
      {shown.map((name) => (
        <Avatar key={name} name={name} size="sm" />
      ))}
      {rest > 0 ? (
        <span className="avatar sm" aria-hidden="true">
          +{rest}
        </span>
      ) : null}
    </span>
  );
}
