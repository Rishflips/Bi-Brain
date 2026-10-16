import { expect, it } from "vitest";
import { OidcClient } from "../../packages/identity/oidc.ts";

it("sign-in cancellation covers a stalled provider body after headers", async () => {
  const controller = new AbortController();
  let bodyCancelled = false;
  const client = new OidcClient({
    issuer: "https://issuer.example.test",
    clientId: "synthetic-client",
    clientSecret: "synthetic-secret",
    publicOrigin: "https://brain.example.test",
    callbackPath: "/auth/callback",
    customFetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(new TextEncoder().encode('{"issuer":')); },
      cancel() { bodyCancelled = true; },
    }), { headers: { "content-type": "application/json" } }),
  });
  let guard: ReturnType<typeof setTimeout> | undefined;
  const cancel = setTimeout(() => controller.abort(), 10);
  try {
    const result = await Promise.race([
      client.begin(controller.signal).then(
        () => "unexpected-success",
        (error: unknown) => error,
      ),
      new Promise((resolve) => { guard = setTimeout(() => resolve("cancellation-not-enforced"), 150); }),
    ]);
    expect(result).toMatchObject({ code: "OIDC_CANCELLED" });
    expect(bodyCancelled).toBe(true);
  } finally {
    clearTimeout(cancel);
    clearTimeout(guard);
  }
});

it("sign-in cancellation is enforced even before headers when a transport ignores its signal", async () => {
  const controller = new AbortController();
  const client = new OidcClient({
    issuer: "https://issuer.example.test", clientId: "synthetic-client",
    clientSecret: "synthetic-secret", publicOrigin: "https://brain.example.test",
    callbackPath: "/auth/callback",
    customFetch: () => new Promise<Response>(() => {}),
  });
  let guard: ReturnType<typeof setTimeout> | undefined;
  const cancel = setTimeout(() => controller.abort(), 10);
  try {
    const result = await Promise.race([
      client.begin(controller.signal).then(() => "unexpected-success", (error: unknown) => error),
      new Promise((resolve) => { guard = setTimeout(() => resolve("cancellation-not-enforced"), 150); }),
    ]);
    expect(result).toMatchObject({ code: "OIDC_CANCELLED" });
  } finally {
    clearTimeout(cancel);
    clearTimeout(guard);
  }
});
