// Query parsing for chronological flows read by `seq` (#113 slices R and CH): run events and
// thread transcripts are a newest window with `beforeSeq` or a tail with `afterSeq`, never a
// numbered page. Limits are validated, never clamped (pagination coverage plan §3.1).

import { DeskmatesError, type PageLimitPolicy, parsePageLimit } from "@deskmates/contracts";

/** A requested page size under `policy`; absent is its default, anything else invalid is 400. */
export function limitOf(raw: string | undefined, policy: PageLimitPolicy): number {
  const parsed = parsePageLimit(raw, policy);
  if (!parsed.ok)
    throw new DeskmatesError("validation", `Invalid page limit (1 to ${policy.max})`, {
      field: "limit",
      max: policy.max,
    });
  return parsed.limit;
}

/** A `seq` bound: absent, or a non-negative integer; anything else is 400. */
export function seqParam(raw: string | undefined, field: string): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!/^\d{1,15}$/.test(raw))
    throw new DeskmatesError("validation", `${field} must be a non-negative integer`, { field });
  return Number(raw);
}
