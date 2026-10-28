import { isAbsolute } from "node:path";
import { deploymentPolicy } from "./deployment.ts";
import { dodoConfig, type RuntimeDodoConfig } from "./dodo-config.ts";

/**
 * Fixed, non-caller-overridable callback path. The same value is given to the
 * OIDC adapter and to the HTTP routes so the registered redirect address can
 * never drift from the served one.
 */
export const DEFAULT_OIDC_CALLBACK_PATH = "/auth/callback";

/** Fail-closed configuration error. Messages name a variable, never a value. */
export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigError";
  }
}

export type RuntimeOidcConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  callbackPath: string;
};

/**
 * Either the unchanged single-owner local runtime, or an explicit managed
 * runtime. No field is optional in managed mode: a deployment either supplies
 * everything the isolation boundary needs or it does not start.
 */
export type RuntimeConfig =
  | { mode: "local" }
  | {
      mode: "managed";
      managedRoot: string;
      publicOrigin: string;
      oidc: RuntimeOidcConfig;
      dodo?: RuntimeDodoConfig;
    };

type Env = Record<string, string | undefined>;

function required(env: Env, name: string, max = 4096): string {
  const raw = env[name];
  if (typeof raw !== "string")
    throw new RuntimeConfigError(`${name} is required in managed mode.`);
  const value = raw.trim();
  if (
    value.length === 0 ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new RuntimeConfigError(`${name} is required in managed mode.`);
  return value;
}

function callbackPath(env: Env): string {
  const raw = env.BRAIN_OIDC_CALLBACK_PATH;
  if (raw === undefined || raw.trim() === "") return DEFAULT_OIDC_CALLBACK_PATH;
  const value = raw.trim();
  if (
    value.length < 2 ||
    value.length > 512 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("\\") ||
    value.includes("//") ||
    /(^|\/)\.{1,2}(\/|$)/.test(value) ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new RuntimeConfigError(
      "BRAIN_OIDC_CALLBACK_PATH must be one fixed absolute path without a query or fragment.",
    );
  return value;
}

/**
 * Reads and validates the process environment. In managed mode every required
 * field is checked here, before `main` constructs any runtime, storage or
 * adapter, so a half-configured deployment fails closed instead of silently
 * falling back to the local single-owner database.
 */
export function loadConfig(env: Env = process.env): RuntimeConfig {
  const mode = (env.BRAIN_MODE ?? "local").trim();
  if (mode === "local") return { mode: "local" };
  if (mode !== "managed")
    throw new RuntimeConfigError('BRAIN_MODE must be "local" or "managed".');

  const managedRoot = required(env, "BRAIN_MANAGED_ROOT");
  if (!isAbsolute(managedRoot))
    throw new RuntimeConfigError(
      "BRAIN_MANAGED_ROOT must be one absolute path.",
    );

  const publicOrigin = required(env, "BRAIN_PUBLIC_ORIGIN");
  const port = Number(env.BRAIN_PORT ?? 4317);
  // Reuses the deployment origin rules (HTTPS, one bare origin) so managed
  // startup cannot be more permissive than the request guard it feeds. Any
  // underlying error becomes one fail-closed configuration message.
  let secure = false;
  try {
    secure = deploymentPolicy(publicOrigin, port).secure;
  } catch {
    secure = false;
  }
  if (!secure)
    throw new RuntimeConfigError(
      "BRAIN_PUBLIC_ORIGIN must be one HTTPS origin without credentials or a path.",
    );

  const issuer = required(env, "BRAIN_OIDC_ISSUER", 2048);
  if (!/^https:\/\//i.test(issuer))
    throw new RuntimeConfigError("BRAIN_OIDC_ISSUER must use HTTPS.");
  // An issuer is a bare HTTPS origin plus an optional path. Credentials, a
  // query or a fragment would let a secret-bearing or non-issuer string reach
  // the adapter, so structure is validated here, before storage or adapters
  // are constructed. Only the variable name is ever named in the error.
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuer);
  } catch {
    throw new RuntimeConfigError(
      "BRAIN_OIDC_ISSUER must be one HTTPS issuer URL without credentials, a query, or a fragment.",
    );
  }
  if (
    issuerUrl.protocol !== "https:" ||
    issuerUrl.hostname === "" ||
    issuerUrl.username !== "" ||
    issuerUrl.password !== "" ||
    issuerUrl.search !== "" ||
    issuerUrl.hash !== "" ||
    issuer.includes("?") ||
    issuer.includes("#")
  )
    throw new RuntimeConfigError(
      "BRAIN_OIDC_ISSUER must be one HTTPS issuer URL without credentials, a query, or a fragment.",
    );

  return {
    mode: "managed",
    managedRoot,
    publicOrigin,
    oidc: {
      issuer,
      clientId: required(env, "BRAIN_OIDC_CLIENT_ID", 255),
      clientSecret: required(env, "BRAIN_OIDC_CLIENT_SECRET", 1024),
      callbackPath: callbackPath(env),
    },
    dodo: dodoConfig(env),
  };
}

/** Secret-free one-line description safe for startup logs. */
export function describeConfig(config: RuntimeConfig): string {
  return config.mode === "managed"
    ? `managed runtime at ${config.publicOrigin}`
    : "local single-owner runtime";
}
