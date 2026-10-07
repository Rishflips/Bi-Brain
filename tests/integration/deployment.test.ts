import { expect, it } from "vitest";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { createApp } from "../../apps/server/app.ts";
import { deploymentPolicy } from "../../apps/server/deployment.ts";
import { agentApiUrl } from "../../apps/mcp/api-url.ts";

it("HTTPS owner session captures persistent knowledge with secure cookies and fails closed across hosts and origins", async () => {
  const store = new Storage(":memory:");
  const brain = new Brain(store);
  const secret = "synthetic-https-owner-code-32-characters";
  const origin = "https://brain.example.test";
  const app = await createApp(brain, {
    pairSecret: secret,
    publicOrigin: origin,
    static: false,
  });
  try {
    const paired = await app.inject({
      method: "POST",
      url: "/api/v1/session/pair",
      headers: { host: "brain.example.test", origin },
      payload: { secret },
    });
    expect(paired.statusCode).toBe(200);
    expect(paired.headers["set-cookie"]).toMatch(/; Secure/);
    expect(paired.headers["set-cookie"]).toMatch(/; HttpOnly/);
    expect(paired.headers["strict-transport-security"]).toBe(
      "max-age=31536000",
    );
    const headers = {
      host: "brain.example.test",
      origin,
      cookie: paired.headers["set-cookie"]!.toString().split(";")[0],
      "x-brain-csrf": paired.json().csrf,
    };
    const payload = {
      title: "HTTPS deployment",
      body: "SYNTHETIC_HTTPS_CAPTURE",
      project_id: "inbox",
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/sources",
          headers,
          payload,
        })
      ).statusCode,
    ).toBe(201);
    const source = brain.sources({ kind: "owner" })[0];
    expect(
      (
        await app.inject({ url: `/api/v1/sources/${source.id}`, headers })
      ).json().body,
    ).toBe(payload.body);
    for (const invalid of [
      { ...headers, origin: "http://brain.example.test" },
      { ...headers, origin: "https://brain.example.test.evil.test" },
      { ...headers, origin: "null" },
      {
        ...headers,
        host: "evil.test",
        "x-forwarded-host": "brain.example.test",
        "x-forwarded-proto": "https",
      },
      { ...headers, host: "127.0.0.1:4317" },
      { ...headers, "x-brain-csrf": "wrong" },
    ])
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/sources",
            headers: invalid,
            payload,
          })
        ).statusCode,
      ).toBe(403);
    expect(brain.sources({ kind: "owner" })).toHaveLength(1);
    expect(
      (
        await app.inject({
          url: "/api/v1/today",
          headers: { host: "brain.example.test" },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          url: "/api/v1/health/live",
          headers: { host: "127.0.0.1:4317" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          url: "/api/v1/health/ready",
          headers: { host: "brain.example.test" },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: "DELETE", url: "/api/v1/session", headers }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: "/api/v1/today", headers })).statusCode,
    ).toBe(401);
  } finally {
    await app.close();
    store.close();
  }
});

it("HTTPS grants still filter private knowledge and revoke access without forwarding trust", async () => {
  const store = new Storage(":memory:");
  const brain = new Brain(store);
  const app = await createApp(brain, {
    pairSecret: "synthetic-https-owner-code-32-characters",
    publicOrigin: "https://brain.example.test",
    static: false,
  });
  try {
    const owner = { kind: "owner" } as const;
    brain.capture(owner, {
      title: "Private",
      body: "PRIVATE_HTTPS_SENTINEL",
      visibility: "private",
    });
    const grant = brain.createGrant(owner, {
      projects: ["inbox"],
      operations: ["read"],
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });
    const headers = {
      host: "brain.example.test",
      authorization: `Bearer ${grant.token}`,
    };
    const response = await app.inject({
      url: "/api/v1/context?project_id=inbox",
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("PRIVATE_HTTPS_SENTINEL");
    brain.revoke(owner, grant.id);
    expect(
      (await app.inject({ url: "/api/v1/context?project_id=inbox", headers }))
        .statusCode,
    ).toBe(401);
  } finally {
    await app.close();
    store.close();
  }
});

it("deployment configuration rejects insecure or ambiguous public origins and empty owner codes", async () => {
  for (const value of [
    "http://brain.test",
    "https://user:secret@brain.test",
    "https://brain.test/path",
    "https://brain.test?token=x",
    "https://brain.test#x",
    "",
    " https://brain.test",
  ])
    expect(() => deploymentPolicy(value)).toThrow();
  expect(() => deploymentPolicy(undefined, 0)).toThrow();
  expect(
    deploymentPolicy(undefined, 4444).allowsOrigin("http://localhost:4444"),
  ).toBe(true);
  const store = new Storage(":memory:");
  try {
    await expect(
      createApp(new Brain(store), { pairSecret: "", static: false }),
    ).rejects.toThrow("pairing code");
    await expect(
      createApp(new Brain(store), {
        pairSecret: "short",
        publicOrigin: "https://brain.test",
        static: false,
      }),
    ).rejects.toThrow("pairing code");
  } finally {
    store.close();
  }
});

it("native adapter accepts an explicit HTTPS server and rejects plaintext remote, credential and path-bearing URLs", () => {
  expect(agentApiUrl("https://brain.example.test/")).toBe(
    "https://brain.example.test",
  );
  expect(agentApiUrl("http://127.0.0.1:4317")).toBe("http://127.0.0.1:4317");
  for (const value of [
    "http://brain.test",
    "http://127.0.0.1.evil.test:4317",
    "https://user:secret@brain.test",
    "https://brain.test/path",
    "https://brain.test?secret=x",
    "https://brain.test#x",
    "file:///etc/passwd",
  ])
    expect(() => agentApiUrl(value)).toThrow();
});
