import { describe, expect, it } from "vitest";
import { whatsappProxy } from "./proxy.js";
describe("operator network proxy", () => {
  it("honors lowercase proxy environment and an explicit override", () => {
    expect(whatsappProxy({ https_proxy: "http://127.0.0.1:7890" })).toBe("http://127.0.0.1:7890");
    expect(
      whatsappProxy({
        HTTPS_PROXY: "http://proxy:8080",
        WHATSAPP_WEB_PROXY_URL: "https://other:8443",
      }),
    ).toBe("https://other:8443");
  });
  it("uses a direct connection for NO_PROXY and does not leak an invalid URL", () => {
    expect(
      whatsappProxy({ HTTPS_PROXY: "http://proxy:8080", NO_PROXY: ".whatsapp.com" }),
    ).toBeUndefined();
    expect(whatsappProxy({ HTTPS_PROXY: "http://proxy:8080", NO_PROXY: "localhost" })).toBe(
      "http://proxy:8080",
    );
    expect(() => whatsappProxy({ HTTPS_PROXY: "invalid-secret-value" })).toThrow(
      "Invalid WhatsApp proxy URL",
    );
  });
});
