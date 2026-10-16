import { z } from "zod";
export const id = z.string().min(1).max(100);
export const text = z
  .string()
  .min(1)
  .max(200000)
  .refine(
    (v) =>
      Array.from(v).length <= 100000 && Buffer.byteLength(v, "utf8") <= 1048576,
    "Text exceeds the 100,000 character / 1 MiB limit",
  );
export const captureSchema = z
  .object({
    project_id: id.default("inbox"),
    title: z.string().trim().min(1).max(200),
    body: text,
    visibility: z.enum(["private", "project"]).default("project"),
    separate: z.boolean().default(false),
  })
  .strict();
export const evidenceSchema = z
  .object({
    source_id: id,
    source_version: z.number().int().positive(),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    quote: z.string().min(1).max(10000),
  })
  .strict();
export const itemSchema = z
  .object({
    text: z.string().min(1).max(10000),
    epistemic_status: z.enum(["supported", "user_assertion", "hypothesis"]),
    evidence: z.array(evidenceSchema).max(20),
  })
  .strict();
export const outputSchema = z
  .object({
    items: z.array(itemSchema).max(30),
    unknowns: z.array(z.string().max(1000)).max(20),
  })
  .strict();
export const preferencesSchema = z
  .object({
    enabled: z.boolean(),
    time_zone: z.string().refine((v) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }),
    digest_hour: z.number().int().min(0).max(23),
    quiet_start: z.number().int().min(0).max(23),
    quiet_end: z.number().int().min(0).max(23),
    daily_cap_micro_usd: z.number().int().min(0).max(100000000),
    per_job_cap_micro_usd: z.number().int().min(0).max(10000000),
    provider_enabled: z.boolean(),
  })
  .strict();
export type Evidence = z.infer<typeof evidenceSchema>;
export type Item = z.infer<typeof itemSchema>;
export type Preferences = z.infer<typeof preferencesSchema>;
export type Source = {
  id: string;
  project_id: string;
  version: number;
  title: string;
  body: string;
  visibility: "private" | "project";
  state: string;
  captured_at: string;
  origin: string;
};
export type Entity = {
  id: string;
  project_id: string;
  kind: string;
  version: number;
  data: Record<string, any>;
  created_at: string;
};
// A principal is either the local owner, a local agent grant, or the same
// shapes bound to a managed tenant. `tenantId` is optional so the local
// single-owner deployment keeps working unchanged; a bound principal is only
// accepted by the brain that serves that exact tenant.
export type Principal =
  | { kind: "owner"; tenantId?: string }
  | { kind: "agent"; grant_id: string; tenantId?: string };
