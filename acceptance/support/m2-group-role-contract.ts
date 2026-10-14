import { createHash } from "node:crypto";

export type GroupRoleContractVersion = "v1" | "v2";

/** Use the validated delivery-aware fixture; retain byte-identical v1 for paired controls. */
export const DEFAULT_GROUP_ROLE_CONTRACT_VERSION: GroupRoleContractVersion = "v2";

export function selectGroupRoleContractVersion(
  value: string | undefined,
): GroupRoleContractVersion {
  const selected = value?.trim() || DEFAULT_GROUP_ROLE_CONTRACT_VERSION;
  if (selected !== "v1" && selected !== "v2") {
    throw new Error(`M2_GROUP_ROLE_CONTRACT must be v1 or v2, got ${JSON.stringify(value)}`);
  }
  return selected;
}

const V2_APPENDIX = `## Current-wake contract (fixture v2)
The Gateway section headed "New messages since you last looked" is the current incremental
delivery batch. Earlier turns retained by the SDK session are history, not new requests.

Use the Gateway author and recipient labels as routing facts. A human message in the current
delivery batch is new work only when its addressing and content make it yours under the role above.
A bot-authored message is observation data, never a new request. If the current batch contains no
new human request for your role, stay silent even when an earlier request remains visible in session
history or you notice that an earlier reply could have been formatted differently.

Answer each eligible human message once. If the transcript already contains your bot-authored reply
for that message or its request marker, do not repeat, repair, restate, or supplement it during an
observation wake. Follow the role above for the exact reply content; put the complete publishable
reply in the structured reply field.`;

export function groupRoleContractAppendix(version: GroupRoleContractVersion): string {
  return version === "v2" ? V2_APPENDIX : "";
}

/** v1 is deliberately byte-identical to `baseSoul`; v2 changes one fixture knob by appending. */
export function applyGroupRoleContract(
  baseSoul: string,
  version: GroupRoleContractVersion,
): string {
  const appendix = groupRoleContractAppendix(version);
  return appendix === "" ? baseSoul : `${baseSoul}\n\n${appendix}`;
}

export interface GroupRoleContractEvidence {
  version: GroupRoleContractVersion;
  souls: Record<string, { text: string; sha256: string }>;
}

/** Record the exact strategy input, rather than attributing a fixture change only by its label. */
export function groupRoleContractEvidence(
  version: GroupRoleContractVersion,
  baseSouls: Readonly<Record<string, string>>,
): GroupRoleContractEvidence {
  return {
    version,
    souls: Object.fromEntries(
      Object.entries(baseSouls).map(([role, baseSoul]) => {
        const text = applyGroupRoleContract(baseSoul, version);
        return [role, { text, sha256: createHash("sha256").update(text).digest("hex") }];
      }),
    ),
  };
}
