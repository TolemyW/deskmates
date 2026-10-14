// Choosing a bot's look: one emoji from a short set (or initials), one of the named colours.
// The picker is inline so the New contact dialog can show it; the profile wraps it in a dialog.

import { AVATAR_COLORS, type AvatarColor, type BotAvatar } from "@deskmates/contracts";
import { useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Avatar } from "../../components/ui/avatar.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { errorMessage } from "../../format.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";

/** Each named colour in words, for its swatch and the preview line. */
const COLOUR_NAMES: Readonly<Record<AvatarColor, MessageKey>> = {
  slate: "avatarPicker.colour.slate",
  red: "avatarPicker.colour.red",
  orange: "avatarPicker.colour.orange",
  amber: "avatarPicker.colour.amber",
  green: "avatarPicker.colour.green",
  teal: "avatarPicker.colour.teal",
  blue: "avatarPicker.colour.blue",
  indigo: "avatarPicker.colour.indigo",
  violet: "avatarPicker.colour.violet",
  pink: "avatarPicker.colour.pink",
};

/** A small, varied set: roles, tools, places, creatures. Any single emoji is accepted too. */
export const AVATAR_EMOJI = [
  "🧭",
  "🔭",
  "🧪",
  "🛰️",
  "🤖",
  "🦉",
  "🦊",
  "🐙",
  "🐝",
  "🦀",
  "🐧",
  "🦔",
  "🌵",
  "🍀",
  "🌊",
  "🔥",
  "⚡",
  "🌙",
  "☀️",
  "🪐",
  "🔧",
  "🔑",
  "🧰",
  "📡",
  "📊",
  "📚",
  "✏️",
  "🧮",
  "🎯",
  "🚀",
  "🛡️",
  "🧲",
  "🎲",
  "🎧",
  "🧵",
  "🪄",
] as const;

export function AvatarPicker({
  name,
  value,
  onChange,
  showPreview = true,
}: {
  name: string;
  value: BotAvatar | undefined;
  onChange: (next: BotAvatar | undefined) => void;
  /** Off where the caller already shows the avatar next to the picker. */
  showPreview?: boolean;
}) {
  const [custom, setCustom] = useState("");
  const t = useT();
  const set = (patch: { emoji?: string | undefined; color?: AvatarColor | undefined }) => {
    const emoji = "emoji" in patch ? patch.emoji : value?.emoji;
    const color = "color" in patch ? patch.color : value?.color;
    const next: BotAvatar = {};
    if (emoji !== undefined) next.emoji = emoji;
    if (color !== undefined) next.color = color;
    onChange(emoji === undefined && color === undefined ? undefined : next);
  };
  const graphemes = (text: string): string[] =>
    typeof Intl !== "undefined" && "Segmenter" in Intl
      ? [...new Intl.Segmenter().segment(text)].map((s) => s.segment)
      : [...text];
  return (
    <div className="avatar-picker">
      {showPreview ? (
        <div className="avatar-picker-preview">
          <Avatar name={name || "bot"} avatar={value} size="xl" />
          <span className="muted small">
            {value?.color
              ? value.emoji
                ? t("avatarPicker.preview.emojiOn", { color: t(COLOUR_NAMES[value.color]) })
                : t("avatarPicker.preview.initialsOn", { color: t(COLOUR_NAMES[value.color]) })
              : value?.emoji
                ? t("avatarPicker.preview.emoji")
                : t("avatarPicker.preview.initials")}
          </span>
        </div>
      ) : null}
      <fieldset className="avatar-picker-colors">
        <legend className="small">{t("avatarPicker.colour.legend")}</legend>
        <div className="avatar-swatches">
          <button
            type="button"
            className={`avatar-swatch auto${value?.color ? "" : " selected"}`}
            aria-label={t("avatarPicker.colour.auto")}
            aria-pressed={!value?.color}
            onClick={() => set({ color: undefined })}
          >
            {t("avatarPicker.colour.autoSample")}
          </button>
          {AVATAR_COLORS.map((color: AvatarColor) => (
            <button
              key={color}
              type="button"
              className={`avatar-swatch${value?.color === color ? " selected" : ""}`}
              data-color={color}
              aria-label={t(COLOUR_NAMES[color])}
              aria-pressed={value?.color === color}
              onClick={() => set({ color })}
            />
          ))}
        </div>
      </fieldset>
      <fieldset className="avatar-picker-emoji">
        <legend className="small">{t("avatarPicker.emoji.legend")}</legend>
        <div className="avatar-emoji-grid">
          <button
            type="button"
            className={`avatar-emoji-option initials${value?.emoji ? "" : " selected"}`}
            aria-label={t("avatarPicker.emoji.initials")}
            aria-pressed={!value?.emoji}
            onClick={() => set({ emoji: undefined })}
          >
            {t("avatarPicker.emoji.initialsSample")}
          </button>
          {AVATAR_EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className={`avatar-emoji-option${value?.emoji === emoji ? " selected" : ""}`}
              aria-label={t("avatarPicker.emoji.option", { emoji })}
              aria-pressed={value?.emoji === emoji}
              onClick={() => set({ emoji })}
            >
              {emoji}
            </button>
          ))}
        </div>
        <label className="avatar-custom">
          {t("avatarPicker.emoji.custom")}
          <input
            value={custom}
            placeholder="🐲"
            maxLength={16}
            onChange={(e) => {
              const text = e.target.value.trim();
              setCustom(text);
              const parts = graphemes(text);
              if (parts.length === 1) set({ emoji: parts[0] });
            }}
          />
        </label>
      </fieldset>
    </div>
  );
}

/** Saves the choice through `PATCH /api/bots/:id`; `null` clears it back to initials. */
export function AvatarDialog({
  api,
  botId,
  name,
  avatar,
  open,
  onClose,
  onSaved,
}: {
  api: ApiClient;
  botId: string;
  name: string;
  avatar: BotAvatar | undefined;
  open: boolean;
  onClose: () => void;
  onSaved: (avatar: BotAvatar | undefined) => void;
}) {
  const [draft, setDraft] = useState<BotAvatar | undefined>(avatar);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const t = useT();
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const saved = await api.updateBot(botId as Parameters<ApiClient["updateBot"]>[0], {
        avatar: draft ?? null,
      });
      onSaved(saved.avatar);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) {
          setDraft(avatar);
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-md" closeLabel={t("avatarPicker.dialog.close")}>
        <DialogTitle className="pr-8 text-lg font-semibold">
          {t("avatarPicker.dialog.title", { name })}
        </DialogTitle>
        <DialogDescription className="mt-1 text-sm text-muted-foreground">
          {t("avatarPicker.dialog.description", { name })}
        </DialogDescription>
        <AvatarPicker name={name} value={draft} onChange={setDraft} />
        {error ? <p className="error small">{error}</p> : null}
        <div className="dialog-actions">
          <Button variant="outline" type="button" onClick={onClose} disabled={busy}>
            {t("avatarPicker.dialog.cancel")}
          </Button>
          <Button variant="default" type="button" onClick={() => void save()} disabled={busy}>
            {t("avatarPicker.dialog.save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
