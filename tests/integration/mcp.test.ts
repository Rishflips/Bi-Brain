import { it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { createApp } from "../../apps/server/app.ts";
import { Worker } from "../../apps/worker/engine.ts";
it("official SDK stdio client remembers, fresh-session recalls, corrects, excludes private/unrelated, and denies revoked access", async () => {
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
  async function connect() {
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
          BRAIN_AGENT_TOKEN: grant.token,
          BRAIN_API_URL: `http://127.0.0.1:${port}`,
        },
        stderr: "pipe",
      }),
    );
    return client;
  }
  try {
    const first = await connect();
    expect((await first.listTools()).tools.map((t) => t.name)).toHaveLength(5);
    const remembered = await first.callTool({
      name: "brain_remember",
      arguments: {
        project_id: "inbox",
        text: "MCP_UNIQUE_LANTERN 🧠 launch Monday",
        source_attribution: "Agent test assertion",
      },
    });
    expect(remembered.isError).not.toBe(true);
    const sourceId = JSON.parse((remembered.content as any)[0].text).source_id;
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
      name: "brain_context",
      arguments: { project_id: "inbox", max_tokens: 1000 },
    });
    expect(JSON.stringify(context)).toContain("MCP_UNIQUE_LANTERN");
    expect(JSON.stringify(context)).not.toContain("PRIVATE_MCP_SECRET");
    const denied = await fresh.callTool({
      name: "brain_get",
      arguments: { project_id: "inbox", object_id: secret.source_id },
    });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).not.toContain("OTHER_MCP_SECRET");
    const changes = await fresh.callTool({
      name: "brain_changes",
      arguments: { project_id: "inbox" },
    });
    const cursor = JSON.parse((changes.content as any)[0].text).opaque_cursor;
    brain.editSource(owner, sourceId, {
      expected_version: 1,
      title: "Corrected",
      body: "MCP_UNIQUE_LANTERN launch Friday",
    });
    while (await worker.tick()) {}
    const corrected = await fresh.callTool({
      name: "brain_context",
      arguments: { project_id: "inbox" },
    });
    expect(JSON.stringify(corrected)).toContain("Friday");
    expect(JSON.stringify(corrected)).not.toContain("Monday");
    const delta = await fresh.callTool({
      name: "brain_changes",
      arguments: { project_id: "inbox", opaque_cursor: cursor },
    });
    expect(JSON.parse((delta.content as any)[0].text).changes[0].version).toBe(
      2,
    );
    expect(brain.connections(owner)[0].status).toBe("Connected");
    brain.revoke(owner, grant.id);
    const revoked = await fresh.callTool({
      name: "brain_search",
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
