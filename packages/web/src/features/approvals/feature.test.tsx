// @vitest-environment jsdom
// T0: the Approvals navigation entry, its pending-count badge, and the inbox screen.

import type { ApprovalId } from "@deskmates/contracts";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { ShieldCheck } from "lucide-react";
import { afterEach, expect, it } from "vitest";
import { createApiClient } from "../../api/client.js";
import {
  STUB_CONTEXT,
  describeNavEntry,
  describeRender,
} from "../../app/testing/feature-expectations.js";
import { currentI18n } from "../../i18n/intl.js";
import { approval, fakeFetch, installFakeEventSource } from "../../test-support/fixtures.js";
import { ApprovalsScreen } from "./approvals.js";
import { feature } from "./feature.js";

afterEach(cleanup);

describeNavEntry({
  folder: "approvals",
  feature,
  group: "talk",
  order: 30,
  icon: ShieldCheck,
  label: "app.nav.attention",
  english: "Approvals",
  href: "#/approvals",
  currentAt: ["#/approvals"],
  visibleTo: { manager: true, member: true },
});

describeRender("approvals", [["#/approvals", ApprovalsScreen, { api: STUB_CONTEXT.api }]]);

it("counts the pending approvals and names the link with the count", async () => {
  installFakeEventSource();
  const { fetch } = fakeFetch({
    "GET /api/approvals?status=pending": {
      approvals: [approval(), approval({ id: "apr_2" as ApprovalId })],
    },
  });
  const badge = feature.nav?.badge;
  expect(badge).toBeDefined();
  const ctx = { ...STUB_CONTEXT, api: createApiClient({ fetch }) };
  const { result } = renderHook(() => badge?.useCount(ctx));
  await waitFor(() => expect(result.current).toBe(2));
  expect(badge?.name(currentI18n().t, 2)).toBe("Approvals, 2 pending");
});
