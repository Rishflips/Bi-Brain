import { z } from "zod";
export const claimType = z.enum([
  "fact",
  "decision",
  "identity",
  "intent",
  "rule",
  "hypothesis",
  "unknown",
]);
export const aspectValue = z.discriminatedUnion("aspect", [
  z.object({
    aspect: z.literal("status"),
    value: z.enum(["planned", "active", "paused", "done", "cancelled"]),
  }),
  z.object({ aspect: z.literal("deadline"), value: z.iso.datetime() }),
  z.object({ aspect: z.literal("count"), value: z.number().int().safe() }),
  z.object({
    aspect: z.literal("location"),
    value: z.string().trim().min(1).max(300),
  }),
  z.object({
    aspect: z.literal("name"),
    value: z.string().trim().min(1).max(300),
  }),
  z.object({
    aspect: z.literal("preference"),
    value: z.string().trim().min(1).max(300),
  }),
  z.object({
    aspect: z.literal("statement"),
    value: z.string().trim().min(1).max(1000),
  }),
]);
export const proposeSchema = z
  .object({
    project_id: z.string().min(1).max(100),
    title: z.string().trim().min(1).max(200),
    text: z.string().min(1).max(100000),
    type: claimType.default("unknown"),
    entity: z.string().trim().min(1).max(200).optional(),
    field: aspectValue.optional(),
    valid_from: z.iso.datetime().optional(),
    valid_to: z.iso.datetime().optional(),
  })
  .strict();
export type GateResult = {
  proposal_id: string;
  raw_id: string;
  disposition: "commit" | "queue" | "drop";
  type: z.infer<typeof claimType>;
  confidence: number;
  reason_codes: string[];
  policy_version: string;
  classifier_version: string;
  claim_ids: string[];
};
export const policyVersion = "claim-gate-v1";
export const classifierVersion = "offline-literal-v1";
export function classify(v: z.infer<typeof proposeSchema>) {
  // Confidence reflects deterministic syntax/literal support, not truth.
  const value = v.field?.value;
  const literal = value !== undefined && v.text.includes(String(value));
  const complete = !!v.entity && !!v.field && literal;
  return {
    confidence: complete ? 0.98 : 0.25,
    reason: complete
      ? "literal_value_in_raw"
      : "insufficient_structured_evidence",
  };
}
export function overlaps(
  a: { valid_from: string; valid_to?: string },
  b: { valid_from: string; valid_to?: string },
) {
  return (
    Date.parse(a.valid_from) <
      Date.parse(b.valid_to ?? "9999-12-31T23:59:59.999Z") &&
    Date.parse(b.valid_from) <
      Date.parse(a.valid_to ?? "9999-12-31T23:59:59.999Z")
  );
}
