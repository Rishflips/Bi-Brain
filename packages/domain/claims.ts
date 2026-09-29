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
    intent: z
      .object({
        action: z.enum(["propose", "update", "close"]),
        target_id: z.string().uuid().optional(),
        expected_version: z.number().int().positive().optional(),
        success_criteria: z.string().max(2000).optional(),
        due_at: z.iso.datetime().optional(),
        review_at: z.iso.datetime().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (v) =>
      !v.valid_to ||
      !v.valid_from ||
      Date.parse(v.valid_from) < Date.parse(v.valid_to),
    { message: "Validity end must be after its start.", path: ["valid_to"] },
  )
  .refine((v) => v.type !== "intent" || !!v.intent, {
    message: "Intent proposals need a typed action.",
    path: ["intent"],
  })
  .refine(
    (v) =>
      !v.intent ||
      v.intent.action === "propose" ||
      (!!v.intent.target_id && !!v.intent.expected_version),
    { message: "Intent changes need a target and version.", path: ["intent"] },
  );
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
export const policyVersion = "claim-gate-v2";
export const classifierVersion = "exact-assertion-v1";
export function classify(v: z.infer<typeof proposeSchema>) {
  // Only this complete, single-line grammar supports automatic admission. It
  // asserts the named entity/aspect/value; arbitrary prose needs owner review.
  const supported =
    !!v.entity &&
    /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(v.entity) &&
    !/^(i|me|my|myself|owner|user|identity)$/i.test(v.entity) &&
    !!v.field &&
    ["status", "count", "deadline"].includes(v.field.aspect) &&
    v.text.trim().toLocaleLowerCase() ===
      `${v.entity} ${v.field.aspect} ${String(v.field.value)}`.toLocaleLowerCase();
  return {
    supported,
    // No calibrated classifier is installed. The numeric API field is unrated.
    confidence: 0,
    reason: supported
      ? "exact_structured_assertion"
      : "owner_review_unverified_prose",
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
