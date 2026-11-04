import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { BrainError } from "../../packages/domain/logic.ts";
import { SERVER_INSTRUCTIONS } from "../mcp/surface.ts";
import { capabilitiesResource, registerBrainTools, type Call } from "../mcp/tools.ts";

export const MCP_HTTP_BODY_LIMIT = 256 * 1024;
export const MCP_HTTP_PER_MINUTE = 120;
const NOT_POST = "This address answers POST only; there is no stream to open and no session to end.";
const NO_BATCH = "Send one request at a time.";

/**
 * Streamable HTTP MCP, stateless and JSON-only, for harnesses that only speak remote MCP. Every tool call goes back through this
 * server's own HTTP routes with the caller's bearer and the caller's address, so authorization, validation, idempotency, rate buckets
 * and the content-free logs are the routes' own and the same as the stdio adapter's. There is no session, no stream, no batch and no
 * OAuth: bearer grants only, one message per request, behind the request hook that already checks Host, Origin, path escapes and
 * navigations. This route is limited to 120 requests a minute per address by its own bucket, which takes the place of the global
 * 1,000-a-minute bucket on this route only; every other route, including the inner calls below, keeps the global bucket.
 */
export function mcpHttpRoute(app: FastifyInstance) {
  const refuse = async (req: FastifyRequest, reply: FastifyReply) => {
    reply.code(405).header("Allow", "POST").send({ error: { code: "INVALID_INPUT", message: NOT_POST, request_id: req.id, retryable: false } });
  };
  app.get("/api/v1/agent/mcp", refuse);
  app.delete("/api/v1/agent/mcp", refuse);
  // The limiter hook below runs first and marks the request as limited, so the global limiter's own hook then skips it:
  // on this route the 120-a-minute bucket replaces the global one rather than adding to it. That is stricter, which is the intent.
  app.post("/api/v1/agent/mcp", { bodyLimit: MCP_HTTP_BODY_LIMIT, onRequest: app.rateLimit({ max: MCP_HTTP_PER_MINUTE, timeWindow: 60000 }) }, async (req, reply) => {
    if (req.principal.kind !== "agent") throw new BrainError("FORBIDDEN", "Use an agent token.", 403);
    if (Array.isArray(req.body)) throw new BrainError("INVALID_INPUT", NO_BATCH, 400);
    const authorization = req.headers.authorization!;
    const host = req.headers.host ?? "";
    const remoteAddress = req.ip;
    // The same door the stdio adapter uses: one request per call, same bearer, same Host, the caller's own address, no cookie,
    // no Origin. Each inner call counts against the caller's own global bucket.
    const call: Call = async (path, body, idempotencyKey) => {
      const res = await app.inject({
        method: body === undefined ? "GET" : "POST",
        url: "/api/v1" + path,
        remoteAddress,
        headers: { host, authorization, "content-type": "application/json", ...(body === undefined ? {} : { "idempotency-key": idempotencyKey ?? crypto.randomUUID() }) },
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      });
      const value = res.json();
      if (res.statusCode === 429) throw new Error("BiBrain is busy; try again in a minute.");
      if (res.statusCode >= 400) throw new Error(value?.error?.message ?? "Access unavailable.");
      return value;
    };
    const capabilities = await call("/agent/capabilities");
    const server = new McpServer({ name: "bi-brain", version: "0.3.0" }, { instructions: SERVER_INSTRUCTIONS });
    registerBrainTools(server, call, new Set<string>(capabilities.tools));
    server.registerResource("capabilities", "brain://capabilities", { mimeType: "application/json" }, async () => capabilitiesResource(capabilities, "streamable-http"));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      const request = new Request(`http://${host}/api/v1/agent/mcp`, { method: "POST", headers: { accept: String(req.headers.accept ?? ""), "content-type": "application/json" }, body: JSON.stringify(req.body) });
      const res = await transport.handleRequest(request, { parsedBody: req.body });
      const text = await res.text();
      reply.code(res.status);
      const type = res.headers.get("content-type");
      if (type) reply.header("content-type", type);
      return reply.send(text);
    } finally {
      await transport.close().catch(() => {});
    }
  });
}
