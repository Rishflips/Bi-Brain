import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { z } from "zod";
import { Brain } from "../../packages/domain/service.ts";
import { BrainError, hash } from "../../packages/domain/logic.ts";
import { Storage } from "../../packages/storage/index.ts";
import type { Principal } from "../../packages/contracts/index.ts";
import type { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { managedPaidReason, managedDecisionReason } from "./startup-gates.ts";
import {
  OIDC_CORRELATION_TTL_MS,
  type ManagedLogin,
} from "../../packages/identity/managed-login.ts";
import { deploymentPolicy } from "./deployment.ts";
import type { PaddleBillingService } from "../../packages/runtime/paddle-billing.ts";
import { registerBillingRoutes } from "./billing-routes.ts";

const LOGIN_PATH = "/auth/login";
const CORRELATION_COOKIE = "brain_login";
const SESSION_COOKIE = "brain_session";
const CORRELATION_MAX_AGE_SECONDS = Math.ceil(OIDC_CORRELATION_TTL_MS / 1000);

/** Only the unnormalized path of a request URL, so encoded tricks cannot match. */
function requestPath(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

/**
 * A tiny static recovery page for sign-in errors. Every string is a fixed
 * literal; the provider body, error code, authorization URL and correlation
 * token never appear. This is deliberately not the application shell, so a
 * failed callback cannot route the browser back into the brain UI.
 */
function signInNotice(
  reply: FastifyReply,
  status: number,
  heading: string,
  message: string,
  action: { href: string; label: string } | null,
): string {
  reply.code(status).type("text/html; charset=utf-8");
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${heading}</title></head>`,
    "<body><main>",
    `<h1>${heading}</h1>`,
    `<p>${message}</p>`,
    action ? `<p><a href="${action.href}">${action.label}</a></p>` : "",
    "</main></body></html>",
  ].join("");
}

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal;
    csrf: string;
    // The brain that serves this exact request. Local mode points it at the
    // single local brain; managed mode points it at the tenant selected by the
    // trusted control store.
    brain: Brain;
    releaseRuntime?: () => void;
  }
}
export async function createApp(
  brain: Brain | undefined = undefined,
  options: {
    pairSecret?: string;
    static?: boolean;
    metadataLogs?: boolean;
    publicOrigin?: string;
    managed?: ManagedRuntime;
    /**
     * Standards-based login coordinator. Only valid together with a managed
     * runtime; the local single-owner server never serves sign-in.
     */
    login?: ManagedLogin;
    /**
     * The one fixed callback path the adapter registered. It comes from server
     * protocol configuration, never from a browser-supplied value.
     */
    oidcCallbackPath?: string;
    /**
     * Trusted, closed capability accessor (operator policy + fresh worker lease)
     * bound to the managed root/control and the deployment opt-in. It returns a
     * boolean + static reason only. Absent => false.
     */
    capability?: () => { available: boolean; reason: string };
    /**
     * Trusted, closed DECISION-stage capability accessor (a live decision profile
     * plus a fresh decision worker lease), bound to the managed root/control and the
     * deployment opt-in. Distinct from `capability`; returns a boolean + static
     * reason only. Absent => false.
     */
    decisionCapability?: () => { available: boolean; reason: string };
    /** Closed, managed-only Paddle orchestration. Absent means billing is off. */
    billing?: PaddleBillingService;
  } = {},
) {
  const managed = options.managed;
  const login = options.login;
  if (managed && brain)
    throw new Error(
      "Managed mode serves per-account brains from its runtime; do not pass a shared brain.",
    );
  if (login && !managed)
    throw new Error(
      "Managed sign-in requires a managed runtime; the local server pairs the browser instead.",
    );
  const oidcCallbackPath = options.oidcCallbackPath ?? "/auth/callback";
  if (
    oidcCallbackPath.length < 2 ||
    oidcCallbackPath.length > 512 ||
    !oidcCallbackPath.startsWith("/") ||
    oidcCallbackPath.startsWith("//") ||
    oidcCallbackPath.includes("?") ||
    oidcCallbackPath.includes("#") ||
    oidcCallbackPath.includes("\\") ||
    oidcCallbackPath.includes("//") ||
    /(^|\/)\.{1,2}(\/|$)/.test(oidcCallbackPath)
  )
    throw new Error(
      "The OIDC callback path must be one fixed absolute path without a query or fragment.",
    );
  const deployment = deploymentPolicy(
    options.publicOrigin ?? process.env.BRAIN_PUBLIC_ORIGIN,
    Number(process.env.BRAIN_PORT ?? 4317),
  );
  if (managed && !deployment.secure)
    throw new Error("Managed mode requires an explicit HTTPS public origin.");
  // Local mode keeps the existing single-owner brain. Managed mode never
  // constructs it, so no local database or pairing secret is touched. Only a
  // storage this call created is closed on shutdown; a caller-injected brain
  // stays owned by its caller.
  const ownsLocalBrain = !managed && !brain;
  const localBrain: Brain | undefined = managed
    ? undefined
    : (brain ?? new Brain(new Storage()));
  const app = Fastify({
    bodyLimit: 4 * 1048576,
    logger: false,
  });
  await app.register(cookie);
  // The active local UI polls several authenticated views; keep the global
  // abuse guard above that normal traffic while pairing retains its tight cap.
  await app.register(rateLimit, { max: 1000, timeWindow: 60000 });
  let pairSecret: string | undefined;
  if (!managed) {
    const secretFile = resolve(dirname(localBrain!.store.path), "owner-secret");
    pairSecret = options.pairSecret ?? process.env.BRAIN_OWNER_SECRET;
    if (pairSecret === undefined) {
      mkdirSync(dirname(secretFile), { recursive: true });
      if (!existsSync(secretFile))
        writeFileSync(secretFile, randomBytes(32).toString("hex"), {
          mode: 0o600,
        });
      pairSecret = readFileSync(secretFile, "utf8").trim();
    }
    if (
      !pairSecret ||
      pairSecret.length > 200 ||
      (deployment.secure && pairSecret.length < 32)
    )
      throw new Error(
        "Owner pairing code must be nonempty, at most 200 characters, and at least 32 characters for HTTPS hosting.",
      );
  }
  app.decorateRequest("principal");
  app.decorateRequest("csrf", "");
  app.decorateRequest("brain");
  app.decorateRequest("releaseRuntime");
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
  // Pinned managed handles are released on every response path. onSend runs
  // before the response is delivered, so a released handle is observable
  // before the caller's request promise resolves; onError is a safety net.
  const releaseHandle = (req: FastifyRequest) => {
    req.releaseRuntime?.();
    req.releaseRuntime = undefined;
  };
  app.addHook("onSend", async (req, _reply, payload) => {
    releaseHandle(req);
    return payload;
  });
  app.addHook("onError", async (req) => releaseHandle(req));
  // The application owns only the local storage it created. Closing it here
  // fixes the previously leaked default local database without ever closing a
  // caller-supplied brain.
  app.addHook("onClose", async () => {
    if (ownsLocalBrain) localBrain?.store.close();
  });
  app.addHook("onRequest", async (req, reply) => {
    const host = req.headers.host ?? "";
    if (!deployment.allowsHost(host, req.url))
      throw new BrainError("FORBIDDEN", "Host not allowed.", 403);
    const origin = req.headers.origin;
    if (!deployment.allowsOrigin(origin))
      // The generic API origin rule is never loosened. Only the browser-facing
      // sign-in pages get a plain, static refusal that names the real problem.
      throw new BrainError(
        "FORBIDDEN",
        req.url.startsWith("/auth/")
          ? "This sign-in page cannot be opened from another site."
          : "Origin not allowed.",
        403,
      );
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("Cache-Control", "no-store");
    if (deployment.secure)
      reply.header("Strict-Transport-Security", "max-age=31536000");
    if (process.env.NODE_ENV === "production")
      reply.header(
        "Content-Security-Policy",
        options.billing
          ? "default-src 'self'; script-src 'self' https://cdn.paddle.com; style-src 'self'; img-src 'self' data: https://*.paddle.com; connect-src 'self' https://*.paddle.com; frame-src https://*.paddle.com; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self' https://*.paddle.com"
          : "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'",
      );
    if (
      !req.url.startsWith("/api/v1/") ||
      req.url === "/api/v1/health/live" ||
      req.url === "/api/v1/runtime" ||
      req.url === "/api/v1/session/pair" ||
      requestPath(req.url) === "/api/v1/billing/webhook"
    )
      return;
    const requiresCsrf = !["GET", "HEAD"].includes(req.method);
    try {
      if (managed) {
        // Tenant selection comes only from the trusted control store: an
        // opaque session row, or the hash-indexed agent-token route. Tenant
        // headers, query parameters and payload claims are never consulted.
        if (req.headers.authorization) {
          const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization);
          if (!m)
            throw new BrainError("UNAUTHORIZED", "Access unavailable.", 401);
          const route = managed.control.agentTokenTenant(hash(m[1]));
          if (!route)
            throw new BrainError("UNAUTHORIZED", "Access unavailable.", 401);
          const handle = managed.acquire(route.account_id);
          req.brain = handle.brain;
          req.releaseRuntime = handle.release;
          // Recheck the grant against the tenant-local database every call.
          req.principal = handle.brain.authenticateAgent(m[1]);
        } else {
          const token = req.cookies.brain_session ?? "";
          const session = managed.control.resolveSession(token);
          if (!session)
            throw new BrainError(
              "UNAUTHORIZED",
              "Sign in to your managed brain.",
              401,
            );
          const handle = managed.acquire(session.account_id);
          req.brain = handle.brain;
          req.releaseRuntime = handle.release;
          req.principal = handle.brain.ownerPrincipal();
          req.csrf = session.csrf;
          handle.brain.store.set("owner_activity", handle.brain.now());
          if (requiresCsrf && req.headers["x-brain-csrf"] !== session.csrf)
            throw new BrainError(
              "FORBIDDEN",
              "Refresh this browser before making changes.",
              403,
            );
        }
      } else {
        req.brain = localBrain!;
        if (req.headers.authorization) {
          const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization);
          if (!m)
            throw new BrainError("UNAUTHORIZED", "Access unavailable.", 401);
          req.principal = localBrain!.authenticateAgent(m[1]);
        } else {
          const session = localBrain!.ownerSession(
            req.cookies.brain_session ?? "",
          );
          req.principal = localBrain!.ownerPrincipal();
          req.csrf = session.csrf;
          localBrain!.store.set("owner_activity", localBrain!.now());
          if (requiresCsrf && req.headers["x-brain-csrf"] !== session.csrf)
            throw new BrainError(
              "FORBIDDEN",
              "Refresh this browser before making changes.",
              403,
            );
        }
      }
    } catch (error) {
      releaseHandle(req);
      throw error;
    }
  });
  app.get("/api/v1/health/live", () => ({ live: true }));
  // Public, identity-free runtime metadata. It tells the browser whether this
  // deployment is local or managed and whether a real sign-in link exists, so
  // the UI never shows a pairing form that cannot work or a button that lies.
  app.get("/api/v1/runtime", () => {
    const cap = options.capability?.() ?? { available: false, reason: "off" };
    const decisionCap = options.decisionCapability?.() ?? {
      available: false,
      reason: "off",
    };
    return {
      mode: managed ? "managed" : "local",
      sign_in_url: managed && login ? LOGIN_PATH : null,
      sign_in_available: managed ? !!login : false,
      pairing_available: !managed,
      // One global truth: whether this deployment could run a real provider
      // (operator policy configured AND a fresh worker lease), never a per-account
      // or admission claim. It stays true while a call is busy (usage_pending).
      connected_processing_available: managed ? cap.available : false,
      managed_paid_reason: managed
        ? cap.available
          ? null
          : managedPaidReason(cap.reason)
        : null,
      // Separate DECISION-stage deployment availability (a live decision profile AND
      // fresh decision readiness). It is server configuration only: it carries no
      // account consent, money, model, key, endpoint or total.
      decision_processing_available: managed ? decisionCap.available : false,
      decision_paid_reason: managed
        ? decisionCap.available
          ? null
          : managedDecisionReason(decisionCap.reason)
        : null,
    };
  });
  app.get("/api/v1/health/ready", (req) => ({
    storage: req.brain.store.get("PRAGMA integrity_check"),
    ...req.brain.status(req.principal),
  }));
  if (managed) {
    // Managed accounts never use local pairing; the control store sessions
    // are the only browser credential. Fail closed with an explicit message.
    app.post(
      "/api/v1/session/pair",
      { config: { rateLimit: { max: 10, timeWindow: 60000 } } },
      () => {
        throw new BrainError(
          "PAIRING_UNAVAILABLE",
          "This server uses managed sign-in; local pairing is unavailable.",
          403,
        );
      },
    );
  } else {
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
        const { token, csrf } = localBrain!.issueSession();
        reply.setCookie("brain_session", token, {
          httpOnly: true,
          secure: deployment.secure,
          sameSite: "strict",
          path: "/",
          maxAge: 7 * 86400,
        });
        return { csrf };
      },
    );
  }
  if (managed) {
    // Browser sign-in. The callback path is server protocol configuration, not
    // a browser value, and there is no arbitrary return URL: success always
    // lands on the fixed application root.
    app.get(
      LOGIN_PATH,
      { config: { rateLimit: { max: 10, timeWindow: 60000 } } },
      async (_req, reply) => {
        if (!login)
          return signInNotice(
            reply,
            503,
            "Sign-in unavailable",
            "Sign-in is not configured on this server. Ask the operator to finish managed setup.",
            null,
          );
        let started: { authorizationUrl: string; correlationToken: string };
        try {
          started = await login.begin();
        } catch {
          return signInNotice(
            reply,
            503,
            "Sign-in unavailable",
            "Sign-in could not be started right now. Try again shortly.",
            { href: LOGIN_PATH, label: "Try again" },
          );
        }
        // Short-lived correlation cookie. Lax + the exact callback path means it
        // is sent only on the top-level redirect back from the provider, and it
        // is never a __Host- cookie (which would require path "/").
        reply.setCookie(CORRELATION_COOKIE, started.correlationToken, {
          httpOnly: true,
          secure: deployment.secure,
          sameSite: "lax",
          path: oidcCallbackPath,
          maxAge: CORRELATION_MAX_AGE_SECONDS,
        });
        return reply.redirect(started.authorizationUrl, 302);
      },
    );
    app.get(
      oidcCallbackPath,
      { config: { rateLimit: { max: 10, timeWindow: 60000 } } },
      async (req, reply) => {
        // Consume the correlation cookie on every outcome.
        reply.clearCookie(CORRELATION_COOKIE, {
          path: oidcCallbackPath,
          httpOnly: true,
          secure: deployment.secure,
          sameSite: "lax",
        });
        if (!login)
          return signInNotice(
            reply,
            503,
            "Sign-in unavailable",
            "Sign-in is not configured on this server.",
            null,
          );
        if (requestPath(req.url) !== oidcCallbackPath)
          return signInNotice(
            reply,
            404,
            "Sign-in link not found",
            "This sign-in link is not valid for this server.",
            { href: LOGIN_PATH, label: "Start sign-in again" },
          );
        // The callback URL is rebuilt from the one configured public origin and
        // the raw request URL. Forwarded host/origin headers are never consulted,
        // and the adapter re-validates the exact redirect address.
        const callbackURL = `${deployment.origin}${req.url}`;
        let session: { token: string; expires_at: string };
        try {
          session = await login.complete(
            callbackURL,
            req.cookies[CORRELATION_COOKIE] ?? "",
            req.cookies[SESSION_COOKIE],
          );
        } catch {
          return signInNotice(
            reply,
            400,
            "Sign-in could not be completed",
            "This sign-in attempt expired or could not be verified. Start again from the sign-in page.",
            { href: LOGIN_PATH, label: "Start sign-in" },
          );
        }
        const expires = Date.parse(session.expires_at);
        const maxAge = Number.isFinite(expires)
          ? Math.max(1, Math.floor((expires - Date.now()) / 1000))
          : 7 * 86400;
        reply.setCookie(SESSION_COOKIE, session.token, {
          httpOnly: true,
          secure: true,
          sameSite: "strict",
          path: "/",
          maxAge,
        });
        return reply.redirect("/", 303);
      },
    );
  }
  app.get("/api/v1/session", (req) => {
    req.brain.owner(req.principal);
    // The opaque internal account id lets the browser detect an account switch
    // without ever exposing an identity, token or configuration secret.
    return { csrf: req.csrf, account_id: req.brain.tenantId ?? null };
  });
  app.delete("/api/v1/session", (req, reply) => {
    req.brain.owner(req.principal);
    const token = req.cookies.brain_session ?? "";
    if (managed) managed.control.revokeSession(token);
    else req.brain.revokeSession(req.principal, token);
    reply.clearCookie("brain_session", {
      path: "/",
      secure: deployment.secure,
      httpOnly: true,
      sameSite: "strict",
    });
    return { signed_out: true };
  });
  const params = (req: FastifyRequest) =>
    z.object({ id: z.string().max(100) }).parse(req.params).id;
  const key = (req: FastifyRequest) =>
    z.string().max(200).optional().parse(req.headers["idempotency-key"]);
  const expected = (input: unknown) =>
    z.object({ expected_version: z.number().int().positive() }).parse(input)
      .expected_version;
  app.get("/api/v1/projects", (req) => req.brain.projects(req.principal));
  app.post("/api/v1/projects", (req) =>
    req.brain.createProject(
      req.principal,
      z.object({ title: z.string() }).strict().parse(req.body).title,
    ),
  );
  app.post("/api/v1/sources", (req, reply) => {
    req.brain.owner(req.principal);
    const result = req.brain.capture(req.principal, req.body, key(req));
    reply.code(201);
    return result;
  });
  app.post("/api/v1/import-adapters/preview", (req) =>
    req.brain.previewLocalImport(req.principal, req.body),
  );
  app.post("/api/v1/import-adapters/apply", (req) => {
    const input = z
      .object({ checkpoint: z.string(), selection: z.unknown() })
      .strict()
      .parse(req.body);
    return req.brain.applyLocalImport(
      req.principal,
      input.selection,
      input.checkpoint,
    );
  });
  app.get("/api/v1/sources/:id", (req) => {
    const query = z
      .object({ version: z.coerce.number().int().positive().optional() })
      .strict()
      .parse(req.query);
    return req.brain.source(req.principal, params(req), query.version);
  });
  app.post("/api/v1/sources/:id/versions", (req) =>
    req.brain.editSource(req.principal, params(req), req.body),
  );
  app.post("/api/v1/sources/:id/claim-proposals", (req) =>
    req.brain.proposeSourceClaim(req.principal, params(req), req.body),
  );
  app.post("/api/v1/sources/:id/withdraw", (req) =>
    req.brain.removeSource(
      req.principal,
      params(req),
      expected(req.body),
      false,
    ),
  );
  app.delete("/api/v1/sources/:id", (req) => {
    const v = z
      .object({
        expected_version: z.number().int().positive(),
        confirmation: z.literal("DELETE"),
      })
      .strict()
      .parse(req.body);
    return req.brain.removeSource(
      req.principal,
      params(req),
      v.expected_version,
      true,
    );
  });
  app.get("/api/v1/forget-proofs/:id", (req) =>
    req.brain.forgetProof(req.principal, params(req)),
  );
  app.post("/api/v1/sources/:id/finalize-forget", (req) =>
    req.brain.finalizeForget(req.principal, params(req)),
  );
  app.post("/api/v1/receipts/:id/git-revert", (req) =>
    req.brain.revertAcceptedVaultCommit(req.principal, params(req)),
  );
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
    return req.brain
      .sources(req.principal, v.project_id, v.q)
      .slice(v.offset, v.offset + v.limit)
      .map((s) => ({ ...s, body: Array.from(s.body).slice(0, 500).join("") }));
  });
  app.get("/api/v1/briefs/:id", (req) =>
    req.brain.entity(req.principal, params(req)),
  );
  app.patch("/api/v1/briefs/:id", (req) =>
    req.brain.editBrief(req.principal, params(req), req.body),
  );
  app.post("/api/v1/briefs", (req) => {
    req.brain.owner(req.principal);
    const v = z
      .object({ project_id: z.string().max(100) })
      .strict()
      .parse(req.body);
    req.brain.access(req.principal, v.project_id);
    return req.brain.enqueue(v.project_id, "derive_brief", {
      principal: req.principal,
    });
  });
  app.post("/api/v1/goals", (req) => req.brain.goal(req.principal, req.body));
  app.patch("/api/v1/goals/:id", (req) =>
    req.brain.editGoal(req.principal, params(req), req.body),
  );
  app.post("/api/v1/goals/:id/prepare", (req) =>
    req.brain.prepare(req.principal, params(req)),
  );
  app.get("/api/v1/today", (req) => {
    req.brain.owner(req.principal);
    return {
      briefs: req.brain.entities(req.principal, "brief"),
      goals: req.brain.entities(req.principal, "goal"),
      proposals: req.brain.entities(req.principal, "proposal"),
      receipts: req.brain.entities(req.principal, "receipt").slice(0, 30),
      pings: req.brain.entities(req.principal, "ping").slice(0, 30),
      status: req.brain.status(req.principal),
    };
  });
  app.get("/api/v1/proposals/:id", (req) => {
    req.brain.owner(req.principal);
    return req.brain.entity(req.principal, params(req));
  });
  for (const action of ["accept", "dismiss", "snooze"])
    app.post(`/api/v1/proposals/:id/${action}`, (req) =>
      req.brain.review(req.principal, params(req), action, req.body, key(req)),
    );
  app.post("/api/v1/receipts/:id/undo", (req) =>
    req.brain.undo(
      req.principal,
      params(req),
      z
        .object({ expected_version: z.number().int().nonnegative() })
        .strict()
        .parse(req.body).expected_version,
    ),
  );
  app.get("/api/v1/jobs/:id", (req) =>
    req.brain.job(req.principal, params(req)),
  );
  for (const action of ["cancel", "retry"] as const)
    app.post(`/api/v1/jobs/:id/${action}`, (req) =>
      req.brain.jobAction(req.principal, params(req), action),
    );
  app.get("/api/v1/preferences/background", (req) =>
    req.brain.prefs(req.principal),
  );
  app.patch("/api/v1/preferences/background", (req) => {
    // A managed account cannot switch paid processing on unless this deployment's
    // operator policy is configured and a fresh worker lease exists. An explicit
    // OFF is always accepted; a durable accounting block is refused by the domain
    // (409). Capability never depends on this request.
    if (managed) {
      const cap = options.capability?.() ?? { available: false, reason: "off" };
      const decisionCap = options.decisionCapability?.() ?? {
        available: false,
        reason: "off",
      };
      const body = (
        req.body !== null && typeof req.body === "object" ? req.body : {}
      ) as { provider_enabled?: unknown; decision_provider_enabled?: unknown };
      if (body.provider_enabled === true && !cap.available)
        throw new BrainError(
          "PROVIDER_UNAVAILABLE",
          "Connected model processing is not enabled for this deployment yet. Your saved work stays extractive.",
          503,
        );
      // An explicit decision opt-in is denied unless the separate decision
      // capability is really ready (a live profile + fresh readiness); a withdrawn
      // false is always accepted and omission preserves the raw stored choice.
      if (body.decision_provider_enabled === true && !decisionCap.available)
        throw new BrainError(
          "PROVIDER_UNAVAILABLE",
          "Additional background checks are not available on this installation. Your saved work stays extractive.",
          503,
        );
    }
    return req.brain.prefs(req.principal, req.body);
  });
  app.get("/api/v1/connections", (req) => req.brain.connections(req.principal));
  app.post("/api/v1/proposals/gate", (req) =>
    req.brain.propose(
      req.principal,
      req.body,
      req.headers["idempotency-key"] as string | undefined,
    ),
  );
  app.post("/api/v1/proposals/gate/:id/review", (req) =>
    req.brain.reviewGate(req.principal, params(req), req.body),
  );
  app.get("/api/v1/claims", (req) => {
    const v = z
      .object({
        project_id: z.string().max(100),
        include_retired: z.enum(["true", "false"]).default("false"),
      })
      .strict()
      .parse(req.query);
    return req.brain.currentClaims(
      req.principal,
      v.project_id,
      v.include_retired === "true",
    );
  });
  app.get("/api/v1/pages", (req) => {
    const v = z
      .object({
        project_id: z.string().max(100),
        query: z.string().max(200).default(""),
        include_retired: z.enum(["true", "false"]).default("false"),
      })
      .strict()
      .parse(req.query);
    return req.brain.pages(
      req.principal,
      v.project_id,
      v.query,
      v.include_retired === "true",
    );
  });
  app.get("/api/v1/gates", (req) => {
    req.brain.owner(req.principal);
    const v = z
      .object({ project_id: z.string().max(100) })
      .strict()
      .parse(req.query);
    req.brain.access(req.principal, v.project_id);
    return req.brain
      .entities(req.principal, "gate")
      .filter(
        (g) =>
          g.project_id === v.project_id &&
          (g.data.status === "queued" ||
            (g.data.correction &&
              ["accepted", "rejected", "reverted"].includes(g.data.status))),
      );
  });
  app.post("/api/v1/handoffs", (req) =>
    req.brain.handoff(
      req.principal,
      z
        .object({ project_id: z.string().max(100) })
        .strict()
        .parse(req.body).project_id,
    ),
  );
  app.get("/api/v1/identity-disclosure", (req) => {
    const { project_id } = z
      .object({ project_id: z.string().max(100) })
      .strict()
      .parse(req.query);
    return req.brain.identityDisclosure(req.principal, project_id);
  });
  app.patch("/api/v1/identity-disclosure", (req) => {
    const { project_id, selected } = z
      .object({
        project_id: z.string().max(100),
        selected: z.array(z.string().max(100)).max(30),
      })
      .strict()
      .parse(req.body);
    return req.brain.identityDisclosure(req.principal, project_id, selected);
  });
  app.post("/api/v1/claims/:id/retire", (req) =>
    req.brain.retireClaim(
      req.principal,
      params(req),
      z
        .object({ expected_version: z.number().int().positive() })
        .strict()
        .parse(req.body).expected_version,
    ),
  );
  app.post("/api/v1/agent-grants", (req) => {
    const grant = req.brain.createGrant(req.principal, req.body);
    if (managed && req.brain.tenantId)
      managed.control.registerAgentToken(
        hash(grant.token),
        req.brain.tenantId,
        grant.id,
      );
    return grant;
  });
  app.delete("/api/v1/agent-grants/:id", (req) =>
    req.brain.revoke(req.principal, params(req)),
  );
  app.post("/api/v1/agent/verify", (req) => req.brain.verify(req.principal));
  app.get("/api/v1/agent/capabilities", (req) =>
    req.brain.agentCapabilities(req.principal),
  );
  app.get("/api/v1/agent/search", (req) => {
    const v = z
      .object({
        project_id: z.string().max(100),
        query: z.string().max(200),
        mode: z.enum(["current", "historical", "raw"]).default("current"),
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      })
      .strict()
      .parse(req.query);
    return req.brain.agentSearch(
      req.principal,
      v.project_id,
      v.query,
      v.mode,
      v.offset,
      v.limit,
    );
  });
  app.get("/api/v1/agent/get", (req) => {
    const v = z
      .object({
        project_id: z.string().max(100),
        object_id: z.string().max(100),
        version: z.coerce.number().int().positive().optional(),
      })
      .strict()
      .parse(req.query);
    return req.brain.agentGet(
      req.principal,
      v.project_id,
      v.object_id,
      v.version,
    );
  });
  app.get("/api/v1/agent/ask", (req) => {
    const v = z
      .object({
        project_id: z.string().max(100),
        question: z.string().max(500),
      })
      .strict()
      .parse(req.query);
    return req.brain.agentAsk(req.principal, v.project_id, v.question);
  });
  app.get("/api/v1/agent/diff", (req) => {
    const v = z
      .object({
        project_id: z.string().max(100),
        object_id: z.string().max(100),
        from_version: z.coerce.number().int().positive(),
        to_version: z.coerce.number().int().positive(),
      })
      .strict()
      .parse(req.query);
    return req.brain.agentDiff(
      req.principal,
      v.project_id,
      v.object_id,
      v.from_version,
      v.to_version,
    );
  });
  app.post("/api/v1/agent/propose", (req) =>
    req.brain.propose(req.principal, req.body, key(req)),
  );
  app.post("/api/v1/agent/link", (req) =>
    req.brain.agentLink(req.principal, req.body),
  );
  app.post("/api/v1/agent/forget", (req) => {
    const v = z
      .object({
        project_id: z.string().max(100),
        object_id: z.string().max(100),
        expected_version: z.number().int().positive(),
      })
      .strict()
      .parse(req.body);
    return req.brain.agentForget(
      req.principal,
      v.project_id,
      v.object_id,
      v.expected_version,
    );
  });
  app.post("/api/v1/agent/intent", (req) => {
    const v = z
      .object({
        project_id: z.string().max(100),
        action: z.enum(["list", "get", "propose", "update", "close"]),
        id: z.string().max(100).optional(),
        text: z.string().max(20000).optional(),
        expected_version: z.number().int().positive().optional(),
        success_criteria: z.string().max(2000).optional(),
        due_at: z.iso.datetime().optional(),
        review_at: z.iso.datetime().optional(),
      })
      .strict()
      .parse(req.body);
    return req.brain.agentIntent(req.principal, v.project_id, v.action, v);
  });
  app.get("/api/v1/context", (req) => {
    const v = z
      .object({
        project_id: z.string().max(100),
        max_tokens: z.coerce.number().int().min(64).max(3000).default(3000),
      })
      .strict()
      .parse(req.query);
    return req.brain.context(req.principal, v.project_id, v.max_tokens);
  });
  app.get("/api/v1/changes", (req) => {
    const v = z
      .object({
        project_id: z.string().max(100),
        opaque_cursor: z.string().max(20).optional(),
      })
      .strict()
      .parse(req.query);
    return req.brain.changes(req.principal, v.project_id, v.opaque_cursor);
  });
  app.post("/api/v1/exports", (req) => {
    const v = z
      .object({ project_id: z.string().max(100).optional() })
      .strict()
      .parse(req.body);
    return req.brain.export(req.principal, v.project_id);
  });
  app.post("/api/v1/imports/preview", (req) =>
    req.brain.preview(req.principal, req.body),
  );
  app.post("/api/v1/imports/:id/apply", (req) =>
    req.brain.applyImport(req.principal, params(req)),
  );
  await registerBillingRoutes(app, options.billing);
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
