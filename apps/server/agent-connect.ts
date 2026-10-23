import { existsSync, lstatSync, mkdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Principal } from "../../packages/contracts/index.ts";
import type { Brain } from "../../packages/domain/service.ts";
import { BrainError } from "../../packages/domain/logic.ts";
import {
  AGENT_CLIENTS,
  AGENT_HINTS,
  agentDisplayName,
  checkFolderShape,
  configContents,
  configTarget,
  detectAgents,
  type AgentClient,
} from "../../packages/domain/agents.ts";

export type AgentConnectConfig = {
  available: boolean;
  reason: string;
  dataDir: string;
  apiOrigin: string;
  node: string;
  cli: string;
  home: string;
  pathDirs: string[];
};
export type AgentsStatus = {
  available: boolean;
  reason: string | null;
  clients: { client: AgentClient; name: string; found: boolean; file: string; hint: string }[];
};
export type AgentPreview = { connection_id: string; file: string; contents: string; exists: boolean };
export type AgentConnected = { connection_id: string; file: string; contents: string };

const ONE_STEP_DAYS = 90;
const clientSchema = z.enum(AGENT_CLIENTS);
const previewSchema = z.object({ client: clientSchema, project_id: z.string().min(1).max(100), folder: z.string().max(1100) }).strict();
const connectSchema = previewSchema.extend({ connection_id: z.uuid(), access: z.enum(["suggest", "read"]).default("suggest") }).strict();

export function agentConnect(brain: Brain, config: AgentConnectConfig) {
  const keyFile = (id: string) => join(config.dataDir, "agent-keys", `${id}.json`);
  const requireLocal = () => {
    if (!config.available) throw new BrainError("LOCAL_ONLY", config.reason, 403);
  };
  /** The real folder, or a plain refusal. */
  const realFolder = (folder: string) => {
    const shape = checkFolderShape(folder, isAbsolute);
    if (shape) throw new BrainError("INVALID_INPUT", shape, 400);
    let real: string;
    try {
      real = realpathSync(folder.trim());
    } catch {
      throw new BrainError("INVALID_INPUT", "BiBrain cannot find that folder on this computer.", 400);
    }
    if (!statSync(real).isDirectory()) throw new BrainError("INVALID_INPUT", "That path is a file. Choose the project folder.", 400);
    const data = realpathSync(config.dataDir);
    const rel = relative(data, real);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)))
      throw new BrainError("INVALID_INPUT", "Choose your project folder, not BiBrain's own data folder.", 400);
    return real;
  };
  const target = (client: AgentClient, real: string) => join(real, ...configTarget(client).file);
  const contentsFor = (client: AgentClient, connectionId: string) =>
    configContents(client, { node: config.node, cli: config.cli, connectionId, dataDir: config.dataDir });

  return {
    status(p: Principal): AgentsStatus {
      brain.owner(p);
      const found = config.available
        ? detectAgents({ home: config.home, pathDirs: config.pathDirs, platform: process.platform, exists: existsSync, join })
        : { codex: false, "claude-code": false, cursor: false };
      return {
        available: config.available,
        reason: config.available ? null : config.reason,
        clients: AGENT_CLIENTS.map((client) => ({
          client,
          name: agentDisplayName(client),
          found: found[client],
          file: configTarget(client).file.join("/"),
          hint: AGENT_HINTS[client],
        })),
      };
    },
    preview(p: Principal, input: unknown): AgentPreview {
      brain.owner(p);
      requireLocal();
      const v = previewSchema.parse(input);
      brain.access(p, v.project_id);
      const real = realFolder(v.folder);
      const connection_id = randomUUID();
      const file = target(v.client, real);
      return { connection_id, file, contents: contentsFor(v.client, connection_id), exists: existsSync(file) };
    },
    connect(p: Principal, input: unknown): AgentConnected {
      brain.owner(p);
      requireLocal();
      const v = connectSchema.parse(input);
      const real = realFolder(v.folder);
      const file = target(v.client, real);
      const name = configTarget(v.client).file.join("/");
      if (existsSync(file))
        throw new BrainError("FILE_EXISTS", `BiBrain will not change your existing ${name}. Add the BiBrain lines to it yourself.`, 409);
      if (brain.connections(p).some((c) => c.id === v.connection_id))
        throw new BrainError("ALREADY_USED", "This setup was already used. Start again to get a fresh one.", 409);
      const grant = brain.createGrant(p, {
        id: v.connection_id,
        projects: [v.project_id],
        operations: v.access === "suggest" ? ["read", "propose_memory"] : ["read"],
        expires_at: new Date(brain.clock().getTime() + ONE_STEP_DAYS * 86_400_000).toISOString(),
        client: v.client,
        folder: real,
      });
      const contents = contentsFor(v.client, grant.id);
      try {
        mkdirSync(join(config.dataDir, "agent-keys"), { recursive: true });
        writeFileSync(keyFile(grant.id), JSON.stringify({ api: config.apiOrigin, key: grant.token }), { mode: 0o600, flag: "wx" });
        const dir = configTarget(v.client).dir;
        if (dir) mkdirSync(join(real, dir), { recursive: true });
        writeFileSync(file, contents, { flag: "wx" });
      } catch (error) {
        brain.revoke(p, grant.id);
        try {
          unlinkSync(keyFile(grant.id));
        } catch {}
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new BrainError("FILE_EXISTS", `BiBrain will not change your existing ${name}. Add the BiBrain lines to it yourself.`, 409);
        throw new BrainError("WRITE_FAILED", `BiBrain could not write ${name} in that folder.`, 500);
      }
      return { connection_id: grant.id, file, contents };
    },
    forget(connectionId: string) {
      if (!z.uuid().safeParse(connectionId).success) return;
      try {
        if (lstatSync(keyFile(connectionId)).isFile()) unlinkSync(keyFile(connectionId));
      } catch {}
    },
  };
}
