// T0: the Docker provider options the T2 suites build from the environment. On a host whose
// port-53 answers are fake IPs (Testbox), the egress proxy of a test workspace needs the same
// DoH resolver as the deployment, or the public-reachability cases fail (2026-09-28, v0.2.3).

import { describe, expect, it } from "vitest";
import { testDockerProviderOptions } from "./docker.js";

describe("testDockerProviderOptions", () => {
  it("passes the host's resolver settings to the egress proxy", () => {
    const opts = testDockerProviderOptions({
      EGRESS_PROXY_DOH_URL: " https://223.5.5.5/resolve ",
      EGRESS_PROXY_DNS: "223.5.5.5, 119.29.29.29",
      DESKMATES_HOST_TARGET: "host.lima.internal",
    });
    expect(opts.egressProxyDohUrl).toBe("https://223.5.5.5/resolve");
    expect(opts.egressProxyDns).toEqual(["223.5.5.5", "119.29.29.29"]);
    expect(opts.hostTarget).toBe("host.lima.internal");
  });

  it("leaves every resolver setting out when none is set", () => {
    const opts = testDockerProviderOptions({ EGRESS_PROXY_DOH_URL: "", EGRESS_PROXY_DNS: " " });
    expect(opts).not.toHaveProperty("egressProxyDohUrl");
    expect(opts).not.toHaveProperty("egressProxyDns");
    expect(opts).not.toHaveProperty("hostTarget");
  });
});
