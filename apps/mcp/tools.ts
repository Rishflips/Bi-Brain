import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AGENT_CONTRACT } from "../../packages/domain/agents.ts";
import {
  TOOL_DESCRIPTIONS,
  TOOL_NAMES,
  recallOutputShape,
  renderRecallContent,
  type ToolName,
} from "./surface.ts";

/** One call to the BiBrain HTTP API as the connection: GET when there is no body, POST with an Idempotency-Key otherwise. Throws with a plain message on any failure. */
export type Call = (
  path: string,
  body?: unknown,
  idempotencyKey?: string,
) => Promise<any>;

const project = z.string().min(1).max(100);
const object = z.string().min(1).max(100);
const query = (
  path: string,
  values: Record<string, string | number | boolean | undefined>,
) =>
  path +
  "?" +
  new URLSearchParams(
    Object.entries(values)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, String(v)]),
  ).toString();
const READ_ONLY = new Set<ToolName>(["brain_recall", "brain_open"]);

/** The seven tools, exactly as the stdio adapter has registered them since plan 5. Both transports register from this table, so they can never drift. */
export const TOOL_TABLE: Record<
  ToolName,
  { schema: z.ZodRawShape; execute: (call: Call, v: any) => Promise<any> }
> = {
  brain_recall: {
    schema: {
      query: z.string().min(1).max(500),
      project_id: project.optional(),
      history: z.boolean().optional(),
      limit: z.number().int().min(1).max(20).optional(),
    },
    execute: (call, v) => call(query("/agent/recall", v)),
  },
  brain_open: {
    schema: {
      id: object,
      version: z.number().int().positive().optional(),
      compare_version: z.number().int().positive().optional(),
    },
    execute: (call, v) => call(query("/agent/open", v)),
  },
  brain_propose: {
    schema: {
      project_id: project,
      title: z.string().min(1).max(200),
      text: z.string().min(1).max(100000),
      type: z
        .enum([
          "fact",
          "decision",
          "identity",
          "intent",
          "rule",
          "hypothesis",
          "unknown",
        ])
        .default("unknown"),
      entity: z.string().max(200).optional(),
      field: z.any().optional(),
      valid_from: z.iso.datetime().optional(),
      valid_to: z.iso.datetime().optional(),
      idempotency_key: z.string().max(100).optional(),
    },
    execute: (call, v) => {
      const { idempotency_key, ...body } = v;
      return call("/agent/propose", body, idempotency_key);
    },
  },
  brain_note: {
    schema: {
      project_id: project,
      summary: z.string().max(1000).optional(),
      decisions: z
        .array(
          z.object({
            topic: z.string().min(1).max(120),
            decision: z.string().min(1).max(300),
          }),
        )
        .max(10)
        .optional(),
      open_questions: z.array(z.string().min(1).max(300)).max(10).optional(),
      next_step: z.string().max(300).optional(),
      idempotency_key: z.string().max(100).optional(),
    },
    execute: (call, v) => {
      const { idempotency_key, ...body } = v;
      return call("/agent/note", body, idempotency_key);
    },
  },
  brain_forget: {
    schema: {
      project_id: project,
      object_id: object,
      expected_version: z.number().int().positive(),
    },
    execute: (call, v) => call("/agent/forget", v),
  },
  brain_link: {
    schema: {
      project_id: project,
      from_id: object,
      to_id: object,
      relation: z.enum(["supports", "blocks", "supersedes", "related"]),
      from_version: z.number().int().positive(),
      to_version: z.number().int().positive(),
    },
    execute: (call, v) => call("/agent/link", v),
  },
  brain_intent: {
    schema: {
      project_id: project,
      action: z.enum(["list", "get", "propose", "update", "close"]),
      id: object.optional(),
      text: z.string().max(20000).optional(),
      expected_version: z.number().int().positive().optional(),
      success_criteria: z.string().max(2000).optional(),
      due_at: z.iso.datetime().optional(),
      review_at: z.iso.datetime().optional(),
    },
    execute: (call, v) => call("/agent/intent", v),
  },
};

/** Registers the tools the grant allows, in the surface's order. A tool call marks the connection verified only after it succeeds. */
export function registerBrainTools(
  server: McpServer,
  call: Call,
  allowed: Set<string>,
): void {
  for (const name of TOOL_NAMES) {
    if (!allowed.has(name)) continue;
    const config = TOOL_TABLE[name];
    server.registerTool(
      name,
      {
        description: TOOL_DESCRIPTIONS[name],
        inputSchema: config.schema,
        ...(name === "brain_recall" ? { outputSchema: recallOutputShape } : {}),
        annotations: {
          readOnlyHint: READ_ONLY.has(name),
          destructiveHint: name === "brain_forget",
          idempotentHint: READ_ONLY.has(name),
          openWorldHint: false,
        },
      },
      async (input: any) => {
        try {
          const value = await config.execute(call, input);
          await call("/agent/verify", {});
          if (name === "brain_recall") return renderRecallContent(value);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(value) }],
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text:
                  error instanceof Error ? error.message : "Operation failed.",
              },
            ],
          };
        }
      },
    );
  }
}

/** The brain://capabilities resource, the same on both transports apart from the transport's own name. */
export function capabilitiesResource(
  capabilities: { tools: string[]; projects?: unknown[] },
  transport: "stdio" | "streamable-http",
) {
  return {
    contents: [
      {
        uri: "brain://capabilities",
        text: JSON.stringify({
          tools: [...capabilities.tools],
          projects: capabilities.projects ?? [],
          surface: "v2",
          contract: AGENT_CONTRACT,
          transport,
          binding: "manual until a client adapter is verified",
          private_sources: "owner only",
        }),
      },
    ],
  };
}
