import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { z } from "zod";
import { Brain } from "../../packages/domain/service.ts";
import { BrainError } from "../../packages/domain/logic.ts";
import { Storage } from "../../packages/storage/index.ts";
import type { Principal } from "../../packages/contracts/index.ts";
declare module "fastify" {
  interface FastifyRequest {
    principal: Principal;
    csrf: string;
  }
}
export async function createApp(
  brain = new Brain(new Storage()),
  options: {
    pairSecret?: string;
    static?: boolean;
    metadataLogs?: boolean;
  } = {},
) {
  const app = Fastify({
    bodyLimit: 4 * 1048576,
    logger: false,
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: 60000 });
  const secretFile = resolve(dirname(brain.store.path), "owner-secret");
  let pairSecret = options.pairSecret ?? process.env.BRAIN_OWNER_SECRET;
  if (!pairSecret) {
    mkdirSync(dirname(secretFile), { recursive: true });
    if (!existsSync(secretFile))
      writeFileSync(secretFile, randomBytes(32).toString("hex"), {
        mode: 0o600,
      });
    pairSecret = readFileSync(secretFile, "utf8").trim();
  }
  app.decorateRequest("principal");
  app.decorateRequest("csrf", "");
  app.setErrorHandler((error, request, reply) => {
    const transportStatus = (error as any).statusCode;
    const code =
      error instanceof BrainError
        ? error.code
        : error instanceof z.ZodError
          ? "INVALID_INPUT"
          : transportStatus === 429
            ? "RATE_LIMITED"
            : transportStatus >= 400 && transportStatus < 500
              ? "INVALID_INPUT"
              : "INTERNAL_ERROR";
    const status =
      error instanceof BrainError
        ? error.status
        : error instanceof z.ZodError
          ? 400
          : transportStatus >= 400 && transportStatus < 500
            ? transportStatus
            : 500;
    reply.code(status).send({
      error: {
        code,
        message:
          error instanceof BrainError
            ? error.message
            : error instanceof z.ZodError
              ? "Check the fields and input limits."
              : status === 413
                ? "Input exceeds the size limit."
                : "The operation failed. Your entered text has not been discarded.",
        request_id: request.id,
        retryable: status >= 500,
      },
    });
  });
  if (options.metadataLogs)
    app.addHook("onResponse", async (request, reply) => {
      if (
        request.url.startsWith("/api/v1/") &&
        ![
          "/api/v1/health/live",
          "/api/v1/today",
          "/api/v1/search",
          "/api/v1/projects",
          "/api/v1/connections",
          "/api/v1/preferences/background",
        ].includes(request.routeOptions.url ?? "")
      )
        console.info(
          JSON.stringify({
            event: "request_completed",
            request_id: request.id,
            route: request.routeOptions.url ?? "unmatched",
            method: request.method,
            status: reply.statusCode,
            duration_ms: Math.round(reply.elapsedTime),
          }),
        );
    });
  app.addHook("onRequest", async (req, reply) => {
    const host = req.headers.host ?? "";
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))
      throw new BrainError("FORBIDDEN", "Local host required.", 403);
    const origin = req.headers.origin;
    if (
      origin &&
      !/^http:\/\/(127\.0\.0\.1|localhost):(4317|5173)$/.test(origin)
    )
      throw new BrainError("FORBIDDEN", "Origin not allowed.", 403);
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("Cache-Control", "no-store");
    if (process.env.NODE_ENV === "production")
      reply.header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
    if (
      !req.url.startsWith("/api/v1/") ||
      req.url === "/api/v1/health/live" ||
      req.url === "/api/v1/session/pair"
    )
      return;
    if (req.headers.authorization) {
      const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization);
      if (!m) throw new BrainError("UNAUTHORIZED", "Access unavailable.", 401);
      req.principal = brain.authenticateAgent(m[1]);
    } else {
      const session = brain.ownerSession(req.cookies.brain_session ?? "");
      req.principal = { kind: "owner" };
      req.csrf = session.csrf;
      if (
        !["GET", "HEAD"].includes(req.method) &&
        req.headers["x-brain-csrf"] !== session.csrf
      )
        throw new BrainError(
          "FORBIDDEN",
          "Refresh this browser before making changes.",
          403,
        );
    }
  });
  app.get("/api/v1/health/live", () => ({ live: true }));
  app.get("/api/v1/health/ready", (req) => ({
    storage: brain.store.get("PRAGMA integrity_check"),
    ...brain.status(req.principal),
  }));
  app.post(
    "/api/v1/session/pair",
    { config: { rateLimit: { max: 10, timeWindow: 60000 } } },
    (req, reply) => {
      const { secret } = z
        .object({ secret: z.string().max(200) })
        .strict()
        .parse(req.body);
      const expected = Buffer.from(pairSecret!);
      const got = Buffer.from(secret);
      if (got.length !== expected.length || !timingSafeEqual(got, expected))
        throw new BrainError(
          "UNAUTHORIZED",
          "The installation code did not match.",
          401,
        );
      const { token, csrf } = brain.issueSession();
      reply.setCookie("brain_session", token, {
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        maxAge: 7 * 86400,
      });
      return { csrf };
    },
  );
  app.get("/api/v1/session", (req) => {
    brain.owner(req.principal);
    return { csrf: req.csrf };
  });
  app.delete("/api/v1/session", (req, reply) => {
    brain.owner(req.principal);
    brain.revokeSession(req.principal, req.cookies.brain_session ?? "");
    reply.clearCookie("brain_session", { path: "/" });
    return { signed_out: true };
  });
  const params = (req: FastifyRequest) =>
    z.object({ id: z.string().max(100) }).parse(req.params).id;
  const key = (req: FastifyRequest) =>
    z.string().max(200).optional().parse(req.headers["idempotency-key"]);
  const expected = (input: unknown) =>
    z.object({ expected_version: z.number().int().positive() }).parse(input)
      .expected_version;
  app.get("/api/v1/projects", (req) => brain.projects(req.principal));
  app.post("/api/v1/projects", (req) =>
    brain.createProject(
      req.principal,
      z.object({ title: z.string() }).strict().parse(req.body).title,
    ),
  );
  app.post("/api/v1/sources", (req, reply) => {
    const result = brain.capture(req.principal, req.body, key(req));
    reply.code(201);
    return result;
  });
  app.get("/api/v1/sources/:id", (req) => {
    const query = z
      .object({ version: z.coerce.number().int().positive().optional() })
      .strict()
      .parse(req.query);
    return brain.source(req.principal, params(req), query.version);
  });
  app.post("/api/v1/sources/:id/versions", (req) =>
    brain.editSource(req.principal, params(req), req.body),
  );
  app.post("/api/v1/sources/:id/withdraw", (req) =>
    brain.removeSource(req.principal, params(req), expected(req.body), false),
  );
  app.delete("/api/v1/sources/:id", (req) => {
    const v = z
      .object({
        expected_version: z.number().int().positive(),
        confirmation: z.literal("DELETE"),
      })
      .strict()
      .parse(req.body);
    return brain.removeSource(
      req.principal,
      params(req),
      v.expected_version,
      true,
    );
  });
  app.get("/api/v1/search", (req) => {
    const v = z
      .object({
        q: z.string().max(200).default(""),
        project_id: z.string().max(100).optional(),
        offset: z.coerce.number().int().min(0).max(1000000).default(0),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .strict()
      .parse(req.query);
    return brain
      .sources(req.principal, v.project_id, v.q)
      .slice(v.offset, v.offset + v.limit)
      .map((s) => ({ ...s, body: Array.from(s.body).slice(0, 500).join("") }));
  });
  app.get("/api/v1/briefs/:id", (req) =>
    brain.entity(req.principal, params(req)),
  );
  app.patch("/api/v1/briefs/:id", (req) =>
    brain.editBrief(req.principal, params(req), req.body),
  );
  app.post("/api/v1/briefs", (req) => {
    brain.owner(req.principal);
    const v = z
      .object({ project_id: z.string().max(100) })
      .strict()
      .parse(req.body);
    brain.access(req.principal, v.project_id);
    return brain.enqueue(v.project_id, "derive_brief", {
      principal: req.principal,
    });
  });
  app.post("/api/v1/goals", (req) => brain.goal(req.principal, req.body));
  app.patch("/api/v1/goals/:id", (req) =>
    brain.editGoal(req.principal, params(req), req.body),
  );
  app.post("/api/v1/goals/:id/prepare", (req) =>
    brain.prepare(req.principal, params(req)),
  );
  app.get("/api/v1/today", (req) => {
    brain.owner(req.principal);
    return {
      briefs: brain.entities(req.principal, "brief"),
      goals: brain.entities(req.principal, "goal"),
      proposals: brain.entities(req.principal, "proposal"),
      receipts: brain.entities(req.principal, "receipt").slice(0, 30),
      status: brain.status(req.principal),
    };
  });
  app.get("/api/v1/proposals/:id", (req) => {
    brain.owner(req.principal);
    return brain.entity(req.principal, params(req));
  });
  for (const action of ["accept", "dismiss", "snooze"])
    app.post(`/api/v1/proposals/:id/${action}`, (req) =>
      brain.review(req.principal, params(req), action, req.body, key(req)),
    );
  app.post("/api/v1/receipts/:id/undo", (req) =>
    brain.undo(
      req.principal,
      params(req),
      z
        .object({ expected_version: z.number().int().nonnegative() })
        .strict()
        .parse(req.body).expected_version,
    ),
  );
  app.get("/api/v1/jobs/:id", (req) => brain.job(req.principal, params(req)));
  for (const action of ["cancel", "retry"] as const)
    app.post(`/api/v1/jobs/:id/${action}`, (req) =>
      brain.jobAction(req.principal, params(req), action),
    );
  app.get("/api/v1/preferences/background", (req) =>
    brain.prefs(req.principal),
  );
  app.patch("/api/v1/preferences/background", (req) =>
    brain.prefs(req.principal, req.body),
  );
  app.get("/api/v1/connections", (req) => brain.connections(req.principal));
  app.post("/api/v1/agent-grants", (req) =>
    brain.createGrant(req.principal, req.body),
  );
  app.delete("/api/v1/agent-grants/:id", (req) =>
    brain.revoke(req.principal, params(req)),
  );
  app.post("/api/v1/agent/verify", (req) => brain.verify(req.principal));
  app.get("/api/v1/context", (req) => {
    const v = z
      .object({
        project_id: z.string().max(100),
        max_tokens: z.coerce.number().int().min(64).max(3000).default(3000),
      })
      .strict()
      .parse(req.query);
    return brain.context(req.principal, v.project_id, v.max_tokens);
  });
  app.get("/api/v1/changes", (req) => {
    const v = z
      .object({
        project_id: z.string().max(100),
        opaque_cursor: z.string().max(20).optional(),
      })
      .strict()
      .parse(req.query);
    return brain.changes(req.principal, v.project_id, v.opaque_cursor);
  });
  app.post("/api/v1/exports", (req) => {
    const v = z
      .object({ project_id: z.string().max(100).optional() })
      .strict()
      .parse(req.body);
    return brain.export(req.principal, v.project_id);
  });
  app.post("/api/v1/imports/preview", (req) =>
    brain.preview(req.principal, req.body),
  );
  app.post("/api/v1/imports/:id/apply", (req) =>
    brain.applyImport(req.principal, params(req)),
  );
  if (options.static !== false && existsSync(resolve("dist/web/index.html"))) {
    await app.register(staticPlugin, { root: resolve("dist/web") });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/"))
        reply.code(404).send({
          error: { code: "NOT_FOUND", message: "Endpoint unavailable." },
        });
      else reply.sendFile("index.html");
    });
  }
  return app;
}
