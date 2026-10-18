import { isAbsolute } from "node:path";
import { deploymentPolicy } from "./deployment.ts";

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

export type RuntimePaddleConfig = {
  mode: "sandbox" | "live";
  apiKey: string;
  clientToken: string;
  productRef: string;
  monthlyPriceRef: string;
  annualPriceRef: string;
  allowedCurrencies: string[];
  webhookSecret: string;
  webhookEndpointRef: string;
  portalOrigin: string;
  checkoutPath: string;
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
      paddle?: RuntimePaddleConfig;
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

function paddleConfig(env: Env): RuntimePaddleConfig | undefined {
  const names = [
    "BRAIN_PADDLE_MODE",
    "BRAIN_PADDLE_API_KEY",
    "BRAIN_PADDLE_CLIENT_TOKEN",
    "BRAIN_PADDLE_PRODUCT_ID",
    "BRAIN_PADDLE_MONTHLY_PRICE_ID",
    "BRAIN_PADDLE_ANNUAL_PRICE_ID",
    "BRAIN_PADDLE_ALLOWED_CURRENCIES",
    "BRAIN_PADDLE_WEBHOOK_SECRET",
    "BRAIN_PADDLE_WEBHOOK_ENDPOINT_ID",
    "BRAIN_PADDLE_PORTAL_ORIGIN",
  ] as const;
  const present = names.filter((name) => (env[name] ?? "").trim() !== "");
  if (present.length === 0) return undefined;
  if (present.length !== names.length)
    throw new RuntimeConfigError(
      "Paddle Billing configuration is incomplete; every BRAIN_PADDLE_* field is required when billing is enabled.",
    );
  const mode = required(env, "BRAIN_PADDLE_MODE", 16);
  if (mode !== "sandbox" && mode !== "live")
    throw new RuntimeConfigError(
      'BRAIN_PADDLE_MODE must be "sandbox" or "live".',
    );
  if (mode === "live" && env.BRAIN_PADDLE_ALLOW_LIVE !== "1")
    throw new RuntimeConfigError(
      "Live Paddle Billing stays off until BRAIN_PADDLE_ALLOW_LIVE=1 is explicitly set after the live gate.",
    );
  const apiKey = required(env, "BRAIN_PADDLE_API_KEY", 200);
  const expectedKeyMode = mode === "sandbox" ? "sdbx" : "live";
  const key =
    /^pdl_(live|sdbx)_apikey_[a-z0-9]{26}_[A-Za-z0-9]{22}_[A-Za-z0-9]{3}$/.exec(
      apiKey,
    );
  if (!key || key[1] !== expectedKeyMode)
    throw new RuntimeConfigError(
      "BRAIN_PADDLE_API_KEY must be a current key for BRAIN_PADDLE_MODE.",
    );
  const clientToken = required(env, "BRAIN_PADDLE_CLIENT_TOKEN", 200);
  if (
    !/^(test|live)_[A-Za-z0-9]{20,180}$/.test(clientToken) ||
    clientToken.startsWith(mode === "sandbox" ? "live_" : "test_")
  )
    throw new RuntimeConfigError(
      "BRAIN_PADDLE_CLIENT_TOKEN must match BRAIN_PADDLE_MODE.",
    );
  const id = (name: string, prefix: string) => {
    const value = required(env, name, 100);
    if (!new RegExp(`^${prefix}_[a-z0-9]{26}$`).test(value))
      throw new RuntimeConfigError(`${name} is invalid.`);
    return value;
  };
  const webhookSecret = required(env, "BRAIN_PADDLE_WEBHOOK_SECRET", 200);
  if (!/^pdl_ntfset_[a-z0-9]{26}_[A-Za-z0-9_-]{20,100}$/.test(webhookSecret))
    throw new RuntimeConfigError("BRAIN_PADDLE_WEBHOOK_SECRET is invalid.");
  const allowedCurrencies = required(
    env,
    "BRAIN_PADDLE_ALLOWED_CURRENCIES",
    256,
  ).split(",");
  if (
    allowedCurrencies.length > 20 ||
    allowedCurrencies.some((currency) => !/^[A-Z]{3}$/.test(currency)) ||
    new Set(allowedCurrencies).size !== allowedCurrencies.length
  )
    throw new RuntimeConfigError(
      "BRAIN_PADDLE_ALLOWED_CURRENCIES must be 1-20 unique uppercase ISO currency codes separated by commas.",
    );
  const portalOrigin = required(env, "BRAIN_PADDLE_PORTAL_ORIGIN", 2048);
  let portal: URL;
  try {
    portal = new URL(portalOrigin);
  } catch {
    throw new RuntimeConfigError("BRAIN_PADDLE_PORTAL_ORIGIN is invalid.");
  }
  if (
    portal.protocol !== "https:" ||
    portal.origin !== portalOrigin ||
    portal.port !== "" ||
    portal.username ||
    portal.password
  )
    throw new RuntimeConfigError(
      "BRAIN_PADDLE_PORTAL_ORIGIN must be one bare HTTPS origin.",
    );
  const checkoutPath = (env.BRAIN_PADDLE_CHECKOUT_PATH ?? "/").trim();
  if (
    checkoutPath.length === 0 ||
    checkoutPath.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(checkoutPath) ||
    !checkoutPath.startsWith("/") ||
    checkoutPath.startsWith("//") ||
    checkoutPath.includes("?") ||
    checkoutPath.includes("#") ||
    checkoutPath.includes("\\") ||
    /(^|\/)\.{1,2}(\/|$)/.test(checkoutPath)
  )
    throw new RuntimeConfigError(
      "BRAIN_PADDLE_CHECKOUT_PATH must be one fixed local path.",
    );
  return {
    mode,
    apiKey,
    clientToken,
    productRef: id("BRAIN_PADDLE_PRODUCT_ID", "pro"),
    monthlyPriceRef: id("BRAIN_PADDLE_MONTHLY_PRICE_ID", "pri"),
    annualPriceRef: id("BRAIN_PADDLE_ANNUAL_PRICE_ID", "pri"),
    allowedCurrencies,
    webhookSecret,
    webhookEndpointRef: id("BRAIN_PADDLE_WEBHOOK_ENDPOINT_ID", "ntfset"),
    portalOrigin,
    checkoutPath,
  };
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
    paddle: paddleConfig(env),
  };
}

/** Secret-free one-line description safe for startup logs. */
export function describeConfig(config: RuntimeConfig): string {
  return config.mode === "managed"
    ? `managed runtime at ${config.publicOrigin}`
    : "local single-owner runtime";
}
