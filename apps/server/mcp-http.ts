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
const NOT_JSON = "Send the request as application/json.";
const BUSY = "BiBrain is busy; try again in a minute.";
const UNAVAILABLE = "BiBrain could not answer just now; try again shortly.";

/** A failed inner call: its status and Retry-After are kept so the outer reply can say the same thing, never the inner body. */
class InnerCallError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly retryAfter: string | undefined,
  ) {
    super(message);
  }
}

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
  // Only JSON is read. Fastify already refuses types it has no parser for; text/plain has one, so it is refused here, before parsing.
  const jsonOnly = async <T>(req: FastifyRequest, _reply: FastifyReply, payload: T): Promise<T> => {
    const type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/json") throw new BrainError("UNSUPPORTED_MEDIA_TYPE", NOT_JSON, 415);
    return payload;
  };
  app.post("/api/v1/agent/mcp", { bodyLimit: MCP_HTTP_BODY_LIMIT, onRequest: app.rateLimit({ max: MCP_HTTP_PER_MINUTE, timeWindow: 60000 }), preParsing: jsonOnly }, async (req, reply) => {
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
      let value: any = null;
      try {
        value = res.json();
      } catch {
        value = null;
      }
      if (res.statusCode < 400 && value !== null) return value;
      const retryAfter = res.headers["retry-after"] === undefined ? undefined : String(res.headers["retry-after"]);
      if (res.statusCode === 401 || res.statusCode === 403)
        throw new InnerCallError(value?.error?.message ?? "Access unavailable.", res.statusCode, value?.error?.code ?? (res.statusCode === 401 ? "UNAUTHORIZED" : "FORBIDDEN"), undefined);
      if (res.statusCode === 429) throw new InnerCallError(BUSY, 429, "RATE_LIMITED", retryAfter);
      if (res.statusCode >= 400 && res.statusCode < 500) throw new InnerCallError(value?.error?.message ?? "Access unavailable.", res.statusCode, value?.error?.code ?? "INVALID_INPUT", undefined);
      throw new InnerCallError(UNAVAILABLE, res.statusCode === 503 ? 503 : 502, "UPSTREAM_UNAVAILABLE", retryAfter);
    };
    // The one inner call made before any tool result exists. Its failure is answered as plain HTTP, never as a 500:
    // 401 and 403 unchanged, 429 with the inner Retry-After, anything else a neutral 502 or 503 without the inner body.
    let capabilities: { tools: string[]; projects?: unknown[] };
    try {
      capabilities = await call("/agent/capabilities");
    } catch (error) {
      const inner = error instanceof InnerCallError ? error : new InnerCallError(UNAVAILABLE, 502, "UPSTREAM_UNAVAILABLE", undefined);
      const status = [401, 403, 429, 503].includes(inner.status) ? inner.status : 502;
      if (inner.retryAfter !== undefined) reply.header("Retry-After", inner.retryAfter);
      const upstream = status === 502 || status === 503;
      return reply.code(status).send({ error: { code: upstream ? "UPSTREAM_UNAVAILABLE" : inner.code, message: upstream ? UNAVAILABLE : inner.message, request_id: req.id, retryable: status === 429 || status >= 500 } });
    }
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
