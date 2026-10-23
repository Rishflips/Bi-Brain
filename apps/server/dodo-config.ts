import { RuntimeConfigError } from "./config.ts";

export type RuntimeDodoConfig = {
  mode: "sandbox" | "live";
  apiKey: string;
  businessId: string;
  monthlyProductRef: string;
  annualProductRef: string;
  allowedCurrencies: string[];
  webhookSecret: string;
  webhookEndpointRef: string;
};
export function dodoConfig(
  env: Record<string, string | undefined>,
): RuntimeDodoConfig | undefined {
  const names = [
    "MODE",
    "API_KEY",
    "BUSINESS_ID",
    "MONTHLY_PRODUCT_ID",
    "ANNUAL_PRODUCT_ID",
    "ALLOWED_CURRENCIES",
    "WEBHOOK_SECRET",
    "WEBHOOK_ENDPOINT_ID",
  ];
  const present = Object.entries(env).some(
    ([key, value]) => key.startsWith("BRAIN_DODO_") && !!value?.trim(),
  );
  if (!present) return undefined;
  const value = (name: string) => {
    const raw = env[`BRAIN_DODO_${name}`];
    if (
      !raw ||
      raw.trim() !== raw ||
      raw.length > 512 ||
      /[\u0000-\u0020\u007f]/.test(raw)
    )
      throw new RuntimeConfigError(
        `BRAIN_DODO_${name} is required and must be valid.`,
      );
    return raw;
  };
  names.forEach(value);
  const mode = value("MODE");
  if (mode !== "sandbox" && mode !== "live")
    throw new RuntimeConfigError("BRAIN_DODO_MODE must be sandbox or live.");
  if (mode === "live" && env.BRAIN_DODO_ALLOW_LIVE !== "1")
    throw new RuntimeConfigError(
      "Live Dodo Payments stays off until BRAIN_DODO_ALLOW_LIVE=1.",
    );
  const id = (name: string) => {
    const raw = value(name);
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(raw))
      throw new RuntimeConfigError(`BRAIN_DODO_${name} is invalid.`);
    return raw;
  };
  const currencies = value("ALLOWED_CURRENCIES").split(",");
  if (
    currencies.length > 20 ||
    currencies.some((c) => !/^[A-Z]{3}$/.test(c)) ||
    new Set(currencies).size !== currencies.length
  )
    throw new RuntimeConfigError(
      "BRAIN_DODO_ALLOWED_CURRENCIES requires unique uppercase currency codes.",
    );
  const secret = value("WEBHOOK_SECRET");
  const encoded = secret.replace(/^whsec_/, "");
  if (
    Buffer.from(encoded, "base64").length < 16 ||
    Buffer.from(encoded, "base64").toString("base64") !== encoded
  )
    throw new RuntimeConfigError(
      "BRAIN_DODO_WEBHOOK_SECRET must be a Standard Webhooks signing secret.",
    );
  const monthly = id("MONTHLY_PRODUCT_ID"),
    annual = id("ANNUAL_PRODUCT_ID");
  if (monthly === annual)
    throw new RuntimeConfigError(
      "Dodo monthly and annual products must be distinct.",
    );
  return {
    mode,
    apiKey: value("API_KEY"),
    businessId: id("BUSINESS_ID"),
    monthlyProductRef: monthly,
    annualProductRef: annual,
    allowedCurrencies: currencies,
    webhookSecret: secret,
    webhookEndpointRef: id("WEBHOOK_ENDPOINT_ID"),
  };
}
