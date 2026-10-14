import { startGoldenSite } from "@deskmates/golden-site";
import { expect, it } from "vitest";
import { changeProductOpenCount } from "./m3-product-oracle.js";

it("changes a legitimate app count through its normal close route and leaves a coherent dashboard", async () => {
  const site = await startGoldenSite();
  try {
    const result = await changeProductOpenCount(site.url);
    expect(result.before).toBe(23);
    expect(result.after).toBe(22);
    expect(site.state.ticket(result.ticketId)?.status).toBe("closed");
    const state = site.state.view();
    expect(Object.values(state.tickets).filter((ticket) => ticket.status === "open")).toHaveLength(
      22,
    );
  } finally {
    await site.close();
  }
});
