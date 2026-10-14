// ADR-0023 amendment 2, decision 14 (issue #87): a chat whose member bots include one whose model
// cannot see images says so above the composer, so a person does not send a picture or ask about
// a screenshot expecting it to be seen. Display only: the sidecar withholds the images either way.
// Reads the capabilities route, which never runs a probe; any error shows nothing.

import { type WorkspaceId, visionPolicyFor } from "@deskmates/contracts";
import { useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { useT } from "../../i18n/i18n-provider.js";

export function VisionNotice({
  api,
  workspaceId,
  members,
}: {
  api: ApiClient;
  workspaceId: WorkspaceId | undefined;
  members: readonly { botId: string; name: string }[];
}) {
  const t = useT();
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

  const names = members.filter((m) => withheld.has(m.botId)).map((m) => m.name);
  if (names.length === 0) return null;
  return (
    <p className="vision-notice small" role="note">
      {t("chatPane.visionNotice", { names: names.join(", ") })}
    </p>
  );
}
