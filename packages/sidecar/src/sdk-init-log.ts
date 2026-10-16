// The `log` the sidecar writes when the SDK reports `system/init`: the CLI build and the model id
// the SDK resolved for this attempt (a CLI-side failure such as `unrecognized_model` is only
// explainable when they sit next to the error, issue #68), and the context window the CLI was
// given, so the run screen can show peak input against it before the run ends (issue #9).

import { createHash } from "node:crypto";

export interface SdkInitFields {
  session_id: string;
  claude_code_version?: string;
  model?: string;
}

export function sdkInitLog(
  init: SdkInitFields,
  maxContextTokens: number | undefined,
): Record<string, unknown> {
  return {
    source: "sdk",
    usageSessionFingerprint: createHash("sha256").update(init.session_id).digest("hex"),
    ...(init.claude_code_version === undefined ? {} : { cliVersion: init.claude_code_version }),
    ...(init.model === undefined ? {} : { model: init.model }),
    ...(maxContextTokens === undefined ? {} : { maxContextTokens }),
  };
}
