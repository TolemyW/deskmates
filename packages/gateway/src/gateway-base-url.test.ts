// T1: the URL handed to sandboxes when GATEWAY_BASE_URL is unset (ADR-0002 item 4: the sidecar
// reaches the model only through this Gateway, so the address must be one a container can dial).

import { DOCKER_HOST_ALIAS } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { buildGateway, sandboxReachableHost } from "./index.js";
import { FakeProvider } from "./test-support/fake-provider.js";
import { testConfig } from "./test-support/harness.js";

describe("sandboxReachableHost", () => {
  it("turns an unspecified listen address into the Docker host alias for the Docker provider", () => {
    expect(sandboxReachableHost("0.0.0.0", "docker")).toBe(DOCKER_HOST_ALIAS);
    expect(sandboxReachableHost("::", "docker")).toBe(DOCKER_HOST_ALIAS);
  });

  it("keeps loopback for in-process providers and concrete addresses as they are", () => {
    expect(sandboxReachableHost("0.0.0.0", "fake")).toBe("127.0.0.1");
    expect(sandboxReachableHost("127.0.0.1", "docker")).toBe("127.0.0.1");
    expect(sandboxReachableHost("192.168.1.5", "docker")).toBe("192.168.1.5");
    expect(sandboxReachableHost("::1", "docker")).toBe("[::1]");
  });
});

describe("gatewayBaseUrl derivation", () => {
  it("never hands a sandbox http://0.0.0.0 when listening on every interface", async () => {
    const provider = new FakeProvider("docker");
    const app = buildGateway(testConfig(), provider);
    await app.listen({ port: 0, host: "0.0.0.0" });
    try {
      const addr = app.server.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      expect(app.deskmates.ctx.gatewayBaseUrl()).toBe(`http://${DOCKER_HOST_ALIAS}:${port}`);
    } finally {
      await app.close();
    }
  });

  it("prefers GATEWAY_BASE_URL when it is set", async () => {
    const app = buildGateway(
      testConfig({ gatewayBaseUrl: "http://gateway.internal:9000" }),
      new FakeProvider("docker"),
    );
    await app.listen({ port: 0, host: "0.0.0.0" });
    try {
      expect(app.deskmates.ctx.gatewayBaseUrl()).toBe("http://gateway.internal:9000");
    } finally {
      await app.close();
    }
  });
});
