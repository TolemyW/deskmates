import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type TicketCompletionContractVersion = "baseline" | "verified-stop-v1";

export const DEFAULT_TICKET_COMPLETION_CONTRACT: TicketCompletionContractVersion = "baseline";

interface FixtureFile {
  schemaVersion: number;
  contracts: Record<TicketCompletionContractVersion, { instruction: string }>;
}

const fixture = JSON.parse(
  readFileSync(new URL("./m2-ticket-completion-contract.json", import.meta.url), "utf8"),
) as FixtureFile;

if (fixture.schemaVersion !== 1) {
  throw new Error(`Unsupported ticket completion fixture version ${fixture.schemaVersion}`);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function selectTicketCompletionContract(
  value: string | undefined,
): TicketCompletionContractVersion {
  const selected = value?.trim() || DEFAULT_TICKET_COMPLETION_CONTRACT;
  if (selected !== "baseline" && selected !== "verified-stop-v1") {
    throw new Error(
      `M2_TICKET_COMPLETION_CONTRACT must be baseline or verified-stop-v1, got ${JSON.stringify(value)}`,
    );
  }
  return selected;
}

export function applyTicketCompletionContract(
  basePrompt: string,
  version: TicketCompletionContractVersion,
): string {
  const instruction = fixture.contracts[version].instruction;
  return instruction === "" ? basePrompt : `${basePrompt}\n\n${instruction}`;
}

export interface TicketCompletionContractEvidence {
  fixtureSchemaVersion: 1;
  version: TicketCompletionContractVersion;
  instruction: string;
  instructionSha256: string;
  contractSha256: string;
}

export function ticketCompletionContractEvidence(
  version: TicketCompletionContractVersion,
): TicketCompletionContractEvidence {
  const instruction = fixture.contracts[version].instruction;
  const canonical = JSON.stringify({
    fixtureSchemaVersion: fixture.schemaVersion,
    version,
    instruction,
  });
  return {
    fixtureSchemaVersion: 1,
    version,
    instruction,
    instructionSha256: sha256(instruction),
    contractSha256: sha256(canonical),
  };
}

export function ticketPromptEvidence(
  basePrompt: string,
  version: TicketCompletionContractVersion,
): { text: string; sha256: string } {
  const text = applyTicketCompletionContract(basePrompt, version);
  return { text, sha256: sha256(text) };
}
