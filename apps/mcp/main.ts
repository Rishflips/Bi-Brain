import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { agentApiUrl } from "./api-url.ts";
import { SERVER_INSTRUCTIONS } from "./surface.ts";
import { capabilitiesResource, registerBrainTools } from "./tools.ts";
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
registerBrainTools(server, call, allowed);
server.registerResource(
  "capabilities",
  "brain://capabilities",
  { mimeType: "application/json" },
  async () => capabilitiesResource(capabilities, "stdio"),
);
await server.connect(new StdioServerTransport());
