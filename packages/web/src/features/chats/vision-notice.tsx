// ADR-0023 amendment 2, decision 14 (issue #87): a chat whose member bots include one whose model
// cannot see images says so where it matters, beside the attach button and above a file being
// attached, so a person does not send a picture or ask about a screenshot expecting it to be
// seen. Display only: the sidecar withholds the images either way. Reads the capabilities route,
// which never runs a probe; any error shows nothing.

import { type WorkspaceId, visionPolicyFor } from "@deskmates/contracts";
import { EyeOff } from "lucide-react";
import { useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { useT } from "../../i18n/i18n-provider.js";

/** Names of the members whose model withholds images; empty while loading and on any error. */
export function useBlindMembers(
  api: ApiClient,
  workspaceId: WorkspaceId | undefined,
  members: readonly { botId: string; name: string }[],
): string[] {
  const [withheld, setWithheld] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (workspaceId === undefined) return;
    let active = true;
    api
      .listModelCapabilities(workspaceId)
      .then((list) => {
        if (!active) return;
        const blind = list.filter(
          (c) => (c.visionPolicy ?? visionPolicyFor(c.vision)) === "withhold",
        );
        setWithheld(new Set(blind.flatMap((c) => c.botIds ?? [])));
      })
      .catch(() => {
        if (active) setWithheld(new Set());
      });
    return () => {
      active = false;
    };
  }, [api, workspaceId]);

  return members.filter((m) => withheld.has(m.botId)).map((m) => m.name);
}

/** The badge beside the attach button; hover and a screen reader get the whole sentence. */
export function VisionBadge({ names }: { names: readonly string[] }) {
  const t = useT();
  if (names.length === 0) return null;
  const text = t("chatPane.visionNotice", { names: names.join(", ") });
  return (
    <span className="vision-badge" role="note" title={text}>
      <EyeOff size={14} aria-hidden="true" />
      <span className="sr-only">{text}</span>
    </span>
  );
}

/** The sentence itself, shown while a file is being attached for a bot that cannot see it. */
export function VisionNotice({ names }: { names: readonly string[] }) {
  const t = useT();
  if (names.length === 0) return null;
  return (
    <p className="vision-notice small" role="status">
      {t("chatPane.visionNotice", { names: names.join(", ") })}
    </p>
  );
}
