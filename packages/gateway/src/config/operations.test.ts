// T0: look/OCR, speech and image generation service configuration (ADR-0040 decision 2,
// amendment B decision 17).

import { describe, expect, it } from "vitest";
import { operationStamps, readOperationsConfig } from "./operations.js";

describe("readOperationsConfig", () => {
  it("is off when nothing is set and leaves the run config unchanged", () => {
    expect(readOperationsConfig({})).toEqual({});
    expect(operationStamps({})).toEqual({});
  });

  it("refuses a URL without a model and a model without a URL", () => {
    expect(() => readOperationsConfig({ VISION_OPERATION_URL: "http://10.0.0.1:8005" })).toThrow(
      /VISION_OPERATION_URL and VISION_OPERATION_MODEL are set together/,
    );
    expect(() => readOperationsConfig({ ASR_OPERATION_MODEL: "whisper" })).toThrow(
      /ASR_OPERATION_URL and ASR_OPERATION_MODEL/,
    );
  });

  it("appends the route path to a base URL and keeps a full one", () => {
    const config = readOperationsConfig({
      VISION_OPERATION_URL: "http://10.0.0.5:8005/",
      VISION_OPERATION_MODEL: "qwen3.5-9b-vl",
      ASR_OPERATION_URL: "http://10.0.0.5:8007/v1/audio/transcriptions",
      ASR_OPERATION_MODEL: "whisper-large-v3",
    });
    expect(config.operations?.look).toMatchObject({
      url: "http://10.0.0.5:8005/v1/messages",
      model: "qwen3.5-9b-vl",
      protocol: "anthropic-messages",
    });
    expect(config.operations?.look?.authToken).toBeUndefined();
    expect(config.operations?.look?.priceUsd).toBeUndefined();
    expect(config.operations?.asr).toMatchObject({
      url: "http://10.0.0.5:8007/v1/audio/transcriptions",
      maxBytes: 25 * 1024 * 1024,
      maxSeconds: 1800,
    });
    const stamps = operationStamps(config).operations;
    expect(stamps?.look?.model).toBe("qwen3.5-9b-vl");
    expect(stamps?.look?.endpointSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stamps)).not.toContain("10.0.0.5");
  });

  it("reads the openai-chat route, a token, an explicit zero price and bounds", () => {
    const config = readOperationsConfig({
      VISION_OPERATION_URL: "http://vision.internal",
      VISION_OPERATION_MODEL: "vl",
      VISION_OPERATION_PROTOCOL: "openai-chat",
      VISION_OPERATION_AUTH_TOKEN: "secret-token",
      VISION_OPERATION_PRICE_USD: "0",
      ASR_OPERATION_URL: "http://asr.internal",
      ASR_OPERATION_MODEL: "whisper",
      ASR_OPERATION_PRICE_USD: "0.0001",
      ASR_OPERATION_MAX_BYTES: "1000",
      ASR_OPERATION_MAX_SECONDS: "60",
    });
    expect(config.operations?.look).toMatchObject({
      url: "http://vision.internal/v1/chat/completions",
      authToken: "secret-token",
      priceUsd: 0,
    });
    expect(config.operations?.asr).toMatchObject({
      priceUsd: 0.0001,
      maxBytes: 1000,
      maxSeconds: 60,
    });
    expect(JSON.stringify(operationStamps(config))).not.toContain("secret-token");
  });

  it("refuses an unknown protocol, a negative price and a URL with credentials", () => {
    const base = { VISION_OPERATION_URL: "http://v.internal", VISION_OPERATION_MODEL: "vl" };
    expect(() => readOperationsConfig({ ...base, VISION_OPERATION_PROTOCOL: "grpc" })).toThrow(
      /VISION_OPERATION_PROTOCOL/,
    );
    expect(() => readOperationsConfig({ ...base, VISION_OPERATION_PRICE_USD: "-1" })).toThrow(
      /VISION_OPERATION_PRICE_USD/,
    );
    expect(() =>
      readOperationsConfig({ ...base, VISION_OPERATION_URL: "http://u:p@v.internal" }),
    ).toThrow(/credentials/);
    expect(() =>
      readOperationsConfig({
        ASR_OPERATION_URL: "http://a.internal",
        ASR_OPERATION_MODEL: "whisper",
        ASR_OPERATION_MAX_BYTES: String(26 * 1024 * 1024),
      }),
    ).toThrow(/lower/);
  });
});

// ADR-0040 amendment B, decision 17.
describe("the image generation service", () => {
  const base = { IMAGE_OPERATION_URL: "http://image.internal", IMAGE_OPERATION_MODEL: "local-t2i" };

  it("is set as a pair, gets its route, defaults its size and is stamped without URL or token", () => {
    expect(() => readOperationsConfig({ IMAGE_OPERATION_URL: "http://image.internal" })).toThrow(
      /IMAGE_OPERATION_URL and IMAGE_OPERATION_MODEL are set together/,
    );
    const config = readOperationsConfig({
      ...base,
      IMAGE_OPERATION_AUTH_TOKEN: "img-token",
      IMAGE_OPERATION_PRICE_USD: "0",
    });
    expect(config.operations?.image_generation).toMatchObject({
      url: "http://image.internal/v1/images/generations",
      model: "local-t2i",
      authToken: "img-token",
      priceUsd: 0,
      defaultSize: "1024x1024",
    });
    expect(config.operations?.look).toBeUndefined();
    const stamps = operationStamps(config);
    expect(stamps.operations?.image_generation?.model).toBe("local-t2i");
    expect(JSON.stringify(stamps)).not.toContain("img-token");
    expect(JSON.stringify(stamps)).not.toContain("image.internal");
    // No price set: unpriced, never an inferred zero.
    expect(readOperationsConfig(base).operations?.image_generation?.priceUsd).toBeUndefined();
  });

  it("reads a default size within the bounds and refuses any other", () => {
    expect(
      readOperationsConfig({ ...base, IMAGE_OPERATION_DEFAULT_SIZE: "768x512" }).operations
        ?.image_generation?.defaultSize,
    ).toBe("768x512");
    for (const size of ["1000x1000", "4096x4096", "big"])
      expect(() => readOperationsConfig({ ...base, IMAGE_OPERATION_DEFAULT_SIZE: size })).toThrow(
        /IMAGE_OPERATION_DEFAULT_SIZE/,
      );
    expect(() => readOperationsConfig({ ...base, IMAGE_OPERATION_PRICE_USD: "free" })).toThrow(
      /IMAGE_OPERATION_PRICE_USD/,
    );
  });
});
