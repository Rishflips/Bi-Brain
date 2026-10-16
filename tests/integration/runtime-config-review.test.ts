import { expect, it } from "vitest";
import { resolve } from "node:path";
import { loadConfig } from "../../apps/server/config.ts";

it("rejects malformed managed issuer URLs before either process constructs storage", () => {
  const env = {
    BRAIN_MODE: "managed", BRAIN_MANAGED_ROOT: resolve("synthetic-unused-root"),
    BRAIN_PUBLIC_ORIGIN: "https://brain.example.test", BRAIN_OIDC_CLIENT_ID: "synthetic-client",
    BRAIN_OIDC_CLIENT_SECRET: "synthetic-secret",
  };
  for (const issuer of ["https://", "https://user:synthetic-secret@issuer.example.test", "https://issuer.example.test?secret=synthetic-secret", "https://issuer.example.test#fragment"]) {
    expect(() => loadConfig({ ...env, BRAIN_OIDC_ISSUER: issuer })).toThrow(/BRAIN_OIDC_ISSUER/);
  }
});
