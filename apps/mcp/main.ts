import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { agentApiUrl } from "./api-url.ts";
import {
  SERVER_INSTRUCTIONS,
  TOOL_DESCRIPTIONS,
  TOOL_NAMES,
  recallOutputShape,
  renderRecallContent,
  type ToolName,
} from "./surface.ts";
const base = agentApiUrl(process.env.BRAIN_API_URL ?? "http://127.0.0.1:4317");
if (!process.env.BRAIN_AGENT_TOKEN)
  throw new Error("Set BRAIN_AGENT_TOKEN from an owner-issued grant.");
async function call(path: string, body?: unknown, idempotencyKey?: string) {
  const res = await fetch(base + "/api/v1" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${process.env.BRAIN_AGENT_TOKEN}`,
      "Content-Type": "application/json",
      ...(body === undefined
        ? {}
        : { "Idempotency-Key": idempotencyKey ?? crypto.randomUUID() }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  const value = await res.json();
  if (!res.ok) throw new Error(value.error?.message ?? "Access unavailable.");
  return value;
}
const capabilities = await call("/agent/capabilities");
const allowed = new Set<string>(capabilities.tools);
const server = new McpServer(
  { name: "bi-brain", version: "0.3.0" },
  { instructions: SERVER_INSTRUCTIONS },
);
const project = z.string().min(1).max(100);
const object = z.string().min(1).max(100);
const get = (
  path: string,
  values: Record<string, string | number | boolean | undefined>,
) =>
  call(
    path +
      "?" +
      new URLSearchParams(
        Object.entries(values)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, String(v)]),
      ).toString(),
  );
const READ_ONLY = new Set<ToolName>(["brain_recall", "brain_open"]);
const tools: Record<
  ToolName,
  { schema: z.ZodRawShape; execute: (v: any) => Promise<any> }
> = {
  brain_recall: {
    schema: {
      query: z.string().min(1).max(500),
      project_id: project.optional(),
      history: z.boolean().optional(),
      limit: z.number().int().min(1).max(20).optional(),
    },
    execute: (v) => get("/agent/recall", v),
  },
  brain_open: {
    schema: {
      id: object,
      version: z.number().int().positive().optional(),
      compare_version: z.number().int().positive().optional(),
    },
    execute: (v) => get("/agent/open", v),
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
    execute: (v) => {
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
    execute: (v) => {
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
    execute: (v) => call("/agent/forget", v),
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
    execute: (v) => call("/agent/link", v),
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
    execute: (v) => call("/agent/intent", v),
  },
};
for (const name of TOOL_NAMES) {
  if (!allowed.has(name)) continue;
  const config = tools[name];
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
        const value = await config.execute(input);
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
server.registerResource(
  "capabilities",
  "brain://capabilities",
  { mimeType: "application/json" },
  async () => ({
    contents: [
      {
        uri: "brain://capabilities",
        text: JSON.stringify({
          tools: [...allowed],
          projects: capabilities.projects ?? [],
          surface: "v2",
          binding: "manual until a client adapter is verified",
          private_sources: "owner only",
        }),
      },
    ],
  }),
);
await server.connect(new StdioServerTransport());
