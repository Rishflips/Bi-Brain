import { it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { createApp } from "../../apps/server/app.ts";
import { Worker } from "../../apps/worker/engine.ts";
it("official SDK stdio client proposes through gate, fresh-session recalls raw explicitly, excludes private/unrelated, and denies revoked access", async () => {
  const storage = new Storage(":memory:");
  const brain = new Brain(storage);
  const owner = { kind: "owner" } as const;
  const app = await createApp(brain, {
    pairSecret: "test-only",
    static: false,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as any).port;
  const grant = brain.createGrant(owner, {
    projects: ["inbox"],
    operations: ["read", "propose_memory"],
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  });
  const clients: Client[] = [];
  async function connect(token = grant.token) {
    const client = new Client({
      name: "bi-brain-contract-test",
      version: "1.0.0",
    });
    clients.push(client);
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["node_modules/tsx/dist/cli.mjs", "apps/mcp/main.ts"],
        cwd: process.cwd(),
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (pair): pair is [string, string] => pair[1] !== undefined,
            ),
          ),
          BRAIN_AGENT_TOKEN: token,
          BRAIN_API_URL: `http://127.0.0.1:${port}`,
        },
        stderr: "pipe",
      }),
    );
    return client;
  }
  try {
    const readGrant = brain.createGrant(owner, {
      projects: ["inbox"],
      operations: ["read"],
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });
    const readOnly = await connect(readGrant.token);
    expect(
      (await readOnly.listTools()).tools.every(
        (t) => t.annotations?.readOnlyHint === true,
      ),
    ).toBe(true);
    expect(
      (await readOnly.listTools()).tools.map((t) => t.name).sort(),
    ).toEqual(["brain.search", "brain.get", "brain.ask", "brain.diff"].sort());
    const forbidden = await fetch(
      `http://127.0.0.1:${port}/api/v1/agent/propose`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${readGrant.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          project_id: "inbox",
          title: "No",
          text: "No",
          type: "unknown",
        }),
      },
    );
    expect(forbidden.status).toBe(404);
    const fullGrant = brain.createGrant(owner, {
      projects: ["inbox"],
      operations: ["read", "propose_memory", "forget"],
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });
    const full = await connect(fullGrant.token);
    expect(
      (await full.listTools()).tools.find((t) => t.name === "brain.forget")
        ?.annotations?.destructiveHint,
    ).toBe(true);
    expect(
      (await full.listTools()).tools.find((t) => t.name === "brain.propose")
        ?.annotations?.readOnlyHint,
    ).toBe(false);
    expect((await full.listTools()).tools.map((t) => t.name)).toHaveLength(8);
    const first = await connect();
    expect((await first.listTools()).tools.map((t) => t.name).sort()).toEqual(
      [
        "brain.search",
        "brain.get",
        "brain.propose",
        "brain.link",
        "brain.ask",
        "brain.intent",
        "brain.diff",
      ].sort(),
    );
    const remembered = await first.callTool({
      name: "brain.propose",
      arguments: {
        project_id: "inbox",
        text: "MCP_UNIQUE_LANTERN 🧠 launch Monday",
        title: "Agent test assertion",
        type: "unknown",
      },
    });
    expect(remembered.isError).not.toBe(true);
    const result = JSON.parse((remembered.content as any)[0].text);
    expect(result.disposition).toBe("queue");
    const sourceId = result.raw_id;
    await first.close();
    brain.capture(owner, {
      title: "Private",
      body: "PRIVATE_MCP_SECRET",
      visibility: "private",
    });
    const other = brain.createProject(owner, "Other");
    const secret = brain.capture(owner, {
      project_id: other.id,
      title: "Other",
      body: "OTHER_MCP_SECRET",
    }) as any;
    const worker = new Worker(brain);
    while (await worker.tick()) {}
    const fresh = await connect();
    const context = await fresh.callTool({
      name: "brain.search",
      arguments: { project_id: "inbox", query: "LANTERN", mode: "raw" },
    });
    expect(JSON.stringify(context)).toContain("MCP_UNIQUE_LANTERN");
    expect(JSON.stringify(context)).not.toContain("PRIVATE_MCP_SECRET");
    const denied = await fresh.callTool({
      name: "brain.get",
      arguments: { project_id: "inbox", object_id: secret.source_id },
    });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).not.toContain("OTHER_MCP_SECRET");
    brain.editSource(owner, sourceId, {
      expected_version: 1,
      title: "Corrected",
      body: "MCP_UNIQUE_LANTERN launch Friday",
    });
    while (await worker.tick()) {}
    const corrected = await fresh.callTool({
      name: "brain.search",
      arguments: { project_id: "inbox", query: "LANTERN", mode: "raw" },
    });
    expect(JSON.stringify(corrected)).toContain("Friday");
    expect(JSON.stringify(corrected)).not.toContain("Monday");
    const delta = await fresh.callTool({
      name: "brain.diff",
      arguments: {
        project_id: "inbox",
        object_id: sourceId,
        from_version: 1,
        to_version: 2,
      },
    });
    expect(JSON.parse((delta.content as any)[0].text).changed).toBe(true);
    expect(brain.connections(owner)[0].status).toBe("Connected");
    brain.revoke(owner, grant.id);
    const revoked = await fresh.callTool({
      name: "brain.search",
      arguments: { project_id: "inbox", query: "LANTERN" },
    });
    expect(revoked.isError).toBe(true);
    expect(JSON.stringify(revoked)).not.toContain("MCP_UNIQUE_LANTERN");
  } finally {
    for (const client of clients) await client.close();
    await app.close();
    storage.close();
  }
}, 20000);
