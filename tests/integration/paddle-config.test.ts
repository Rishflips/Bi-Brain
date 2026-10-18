import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeConfigError, loadConfig } from "../../apps/server/config.ts";

const base = {
  BRAIN_MODE: "managed",
  BRAIN_MANAGED_ROOT: resolve("test-results", "paddle-config"),
  BRAIN_PUBLIC_ORIGIN: "https://brain.example.test",
  BRAIN_OIDC_ISSUER: "https://issuer.example.test",
  BRAIN_OIDC_CLIENT_ID: "synthetic-client",
  BRAIN_OIDC_CLIENT_SECRET: "synthetic-secret",
};
const paddle = {
  BRAIN_PADDLE_MODE: "sandbox",
  BRAIN_PADDLE_API_KEY:
    "pdl_sdbx_apikey_01h00000000000000000000000_ABCDEFGHIJKLMNOPQRSTUV_123",
  BRAIN_PADDLE_CLIENT_TOKEN: "test_01234567890123456789012345",
  BRAIN_PADDLE_PRODUCT_ID: "pro_01h00000000000000000000000",
  BRAIN_PADDLE_MONTHLY_PRICE_ID: "pri_01h00000000000000000000000",
  BRAIN_PADDLE_ANNUAL_PRICE_ID: "pri_01h11111111111111111111111",
  BRAIN_PADDLE_ALLOWED_CURRENCIES: "USD,EUR",
  BRAIN_PADDLE_WEBHOOK_SECRET:
    "pdl_ntfset_01h00000000000000000000000_SYNTHETICsecretvalue123",
  BRAIN_PADDLE_WEBHOOK_ENDPOINT_ID: "ntfset_01h00000000000000000000000",
  BRAIN_PADDLE_PORTAL_ORIGIN: "https://sandbox-portal.example",
};

describe("default-off Paddle configuration", () => {
  it("stays absent when no Paddle field is configured", () => {
    const config = loadConfig(base);
    expect(config.mode).toBe("managed");
    if (config.mode === "managed") expect(config.paddle).toBeUndefined();
  });

  it("accepts one complete sandbox boundary and rejects partial or implicit live setup", () => {
    const config = loadConfig({ ...base, ...paddle });
    expect(config.mode).toBe("managed");
    if (config.mode === "managed")
      expect(config.paddle).toMatchObject({ mode: "sandbox" });
    expect(() => loadConfig({ ...base, BRAIN_PADDLE_MODE: "sandbox" })).toThrow(
      RuntimeConfigError,
    );
    expect(() =>
      loadConfig({
        ...base,
        ...paddle,
        BRAIN_PADDLE_MODE: "live",
        BRAIN_PADDLE_API_KEY:
          "pdl_live_apikey_01h00000000000000000000000_ABCDEFGHIJKLMNOPQRSTUV_123",
        BRAIN_PADDLE_CLIENT_TOKEN: "live_01234567890123456789012345",
      }),
    ).toThrow(/stays off/);
  });

  it("rejects ambiguous portal origins and unsafe checkout paths", () => {
    expect(() =>
      loadConfig({
        ...base,
        ...paddle,
        BRAIN_PADDLE_PORTAL_ORIGIN: "https://sandbox-portal.example:8443",
      }),
    ).toThrow(/bare HTTPS origin/);
    expect(() =>
      loadConfig({
        ...base,
        ...paddle,
        BRAIN_PADDLE_CHECKOUT_PATH: "/checkout\u0000hidden",
      }),
    ).toThrow(/fixed local path/);
    expect(() =>
      loadConfig({
        ...base,
        ...paddle,
        BRAIN_PADDLE_CHECKOUT_PATH: `/${"x".repeat(512)}`,
      }),
    ).toThrow(/fixed local path/);
    expect(() =>
      loadConfig({
        ...base,
        ...paddle,
        BRAIN_PADDLE_ALLOWED_CURRENCIES: "USD,usd",
      }),
    ).toThrow(/currency codes/);
  });
});
