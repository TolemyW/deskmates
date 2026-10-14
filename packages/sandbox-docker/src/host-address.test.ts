import { describe, expect, it } from "vitest";
import { gatewayHostForContainer, gatewayUrlForContainer } from "./host-address.js";

describe("host address for containers", () => {
  it("defaults to host.docker.internal and honours an explicit override", () => {
    expect(gatewayHostForContainer()).toBe("host.docker.internal");
    expect(gatewayHostForContainer("  ")).toBe("host.docker.internal");
    expect(gatewayHostForContainer("gateway.internal")).toBe("gateway.internal");
  });

  it("rewrites loopback Gateway URLs so a container can dial them", () => {
    expect(gatewayUrlForContainer("http://127.0.0.1:8080")).toBe(
      "http://host.docker.internal:8080",
    );
    expect(gatewayUrlForContainer("http://localhost:8080/model/")).toBe(
      "http://host.docker.internal:8080/model/",
    );
    expect(gatewayUrlForContainer("http://[::1]:8080/x")).toBe(
      "http://host.docker.internal:8080/x",
    );
  });

  it("leaves non-loopback hosts alone", () => {
    expect(gatewayUrlForContainer("https://gw.example.com/api")).toBe("https://gw.example.com/api");
  });
});
