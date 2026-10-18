import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { BrainError } from "./logic.ts";

/** Strict raw-body Paddle Billing webhook verification. */

export const PADDLE_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
export const PADDLE_WEBHOOK_MAX_HEADER_BYTES = 4 * 1024;
export const PADDLE_WEBHOOK_TOLERANCE_SECONDS = 5;

export interface VerifiedPaddleWebhook {
  timestamp: number;
  body_sha256: string;
  raw_body: Uint8Array;
}

const invalid = (message: string, status = 400) =>
  new BrainError("INVALID_INPUT", message, status);

function parseSignatureHeader(header: string): {
  timestamp: number;
  signatures: Buffer[];
} {
  if (
    !header ||
    Buffer.byteLength(header, "utf8") > PADDLE_WEBHOOK_MAX_HEADER_BYTES
  )
    throw invalid("The Paddle signature header is missing or too large.");
  let timestamp: number | undefined;
  const signatures: Buffer[] = [];
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1)
      throw invalid("The Paddle signature header is malformed.");
    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (key === "ts") {
      if (timestamp !== undefined || !/^\d{1,12}$/.test(value))
        throw invalid("The Paddle signature timestamp is invalid.");
      timestamp = Number(value);
      if (!Number.isSafeInteger(timestamp))
        throw invalid("The Paddle signature timestamp is invalid.");
    } else if (key === "h1") {
      if (!/^[0-9a-f]{64}$/.test(value) || signatures.length === 4)
        throw invalid("The Paddle signature value is invalid.");
      signatures.push(Buffer.from(value, "hex"));
    } else {
      throw invalid(
        "The Paddle signature header contains an unsupported field.",
      );
    }
  }
  if (timestamp === undefined || signatures.length === 0)
    throw invalid("The Paddle signature header is incomplete.");
  return { timestamp, signatures };
}

export function verifyPaddleWebhook(input: {
  raw_body: Uint8Array;
  signature_header: string;
  secret: Uint8Array;
  now: Date;
}): VerifiedPaddleWebhook {
  if (!(input.raw_body instanceof Uint8Array))
    throw invalid("The Paddle webhook body must be raw bytes.");
  if (input.raw_body.byteLength > PADDLE_WEBHOOK_MAX_BODY_BYTES)
    throw invalid("The Paddle webhook body is too large.", 413);
  if (!(input.secret instanceof Uint8Array) || input.secret.byteLength < 16)
    throw invalid("The Paddle webhook secret is unavailable.", 503);
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime()))
    throw invalid("The webhook verification clock is invalid.");

  const parsed = parseSignatureHeader(input.signature_header);
  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  if (
    Math.abs(nowSeconds - parsed.timestamp) > PADDLE_WEBHOOK_TOLERANCE_SECONDS
  )
    throw invalid("The Paddle webhook signature is outside the replay window.");
  const prefix = Buffer.from(`${parsed.timestamp}:`, "utf8");
  const expected = createHmac("sha256", Buffer.from(input.secret))
    .update(prefix)
    .update(Buffer.from(input.raw_body))
    .digest();
  if (
    !parsed.signatures.some((signature) => timingSafeEqual(expected, signature))
  )
    throw invalid("The Paddle webhook signature is invalid.");
  return {
    timestamp: parsed.timestamp,
    body_sha256: createHash("sha256").update(input.raw_body).digest("hex"),
    raw_body: Uint8Array.from(input.raw_body),
  };
}
