import { existsSync, lstatSync, mkdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Principal } from "../../packages/contracts/index.ts";
import type { Brain } from "../../packages/domain/service.ts";
import { BrainError } from "../../packages/domain/logic.ts";
import {
  AGENT_CLIENTS,
  agentDisplayName,
  agentHint,
  checkFolderShape,
  configContents,
  configTarget,
  detectAgents,
  secondFileContents,
  secondFileTarget,
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
export type AgentFile = { path: string; role: "server" | "hook" | "rule"; contents: string; exists: boolean };
export type WrittenFile = { path: string; role: AgentFile["role"]; state: "written" | "exists"; contents: string };
export type AgentPreview = { connection_id: string; file: string; contents: string; exists: boolean; files: AgentFile[] };
export type AgentConnected = { connection_id: string; file: string; contents: string; files: WrittenFile[] };

export const LOCAL_ONLY_REASON = "Adding agents in one step works in the BiBrain app on your computer.";
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
    if (rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel)))
      throw new BrainError("INVALID_INPUT", "Choose your project folder, not BiBrain's own data folder.", 400);
    return real;
  };
  /**
   * Refuses a folder (given as path parts under the project) that is a link. A missing one is fine.
   * A file where a top-level folder must be is refused here; a deeper one is left to the write step, which rolls back.
   */
  const checkDir = (real: string, parts: string[]) => {
    const rel = parts.join("/");
    let info;
    try {
      info = lstatSync(join(real, ...parts));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new BrainError("INVALID_INPUT", `BiBrain cannot check the ${rel} folder. Add the BiBrain lines yourself.`, 400);
    }
    if (info.isSymbolicLink())
      throw new BrainError("INVALID_INPUT", `BiBrain will not write through a linked ${rel} folder. Add the BiBrain lines yourself.`, 400);
    if (!info.isDirectory() && parts.length === 1)
      throw new BrainError("INVALID_INPUT", `That folder has a file named ${rel} where BiBrain needs a folder.`, 409);
  };
  /** Every folder BiBrain may write into for this client: the server file's folder, then each folder above the second file. */
  const checkFolders = (client: AgentClient, real: string) => {
    const chains: string[][] = [];
    const dir = configTarget(client).dir;
    if (dir) chains.push([dir]);
    const second = secondFileTarget(client);
    if (second) for (let i = 1; i < second.file.length; i += 1) chains.push(second.file.slice(0, i));
    const seen = new Set<string>();
    for (const parts of chains) {
      const key = parts.join("/");
      if (seen.has(key)) continue;
      seen.add(key);
      checkDir(real, parts);
    }
  };
  const target = (client: AgentClient, real: string) => join(real, ...configTarget(client).file);
  /** The server file and, when BiBrain writes one, the hook or rule file. Neither contains the access key. */
  const filesFor = (client: AgentClient, real: string, connectionId: string): AgentFile[] => {
    const launch = { node: config.node, cli: config.cli, connectionId, dataDir: config.dataDir };
    const server = target(client, real);
    const out: AgentFile[] = [{ path: server, role: "server", contents: configContents(client, launch), exists: existsSync(server) }];
    const second = secondFileTarget(client);
    const contents = secondFileContents(client, launch);
    if (second && contents) {
      const path = join(real, ...second.file);
      out.push({ path, role: second.role, contents, exists: existsSync(path) });
    }
    return out;
  };

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
          hint: agentHint(client),
        })),
      };
    },
    preview(p: Principal, input: unknown): AgentPreview {
      brain.owner(p);
      requireLocal();
      const v = previewSchema.parse(input);
      brain.access(p, v.project_id);
      const real = realFolder(v.folder);
      checkFolders(v.client, real);
      const connection_id = randomUUID();
      const files = filesFor(v.client, real, connection_id);
      return { connection_id, file: files[0].path, contents: files[0].contents, exists: files[0].exists, files };
    },
    connect(p: Principal, input: unknown): AgentConnected {
      brain.owner(p);
      requireLocal();
      const v = connectSchema.parse(input);
      const real = realFolder(v.folder);
      checkFolders(v.client, real);
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
      const files = filesFor(v.client, real, grant.id);
      const contents = files[0].contents;
      const second = files[1];
      let wroteKey = false;
      let step: "key" | "folder" | "file" | "second" = "key";
      const written: WrittenFile[] = [];
      try {
        mkdirSync(join(config.dataDir, "agent-keys"), { recursive: true, mode: 0o700 });
        writeFileSync(keyFile(grant.id), JSON.stringify({ api: config.apiOrigin, key: grant.token }), { mode: 0o600, flag: "wx" });
        wroteKey = true;
        step = "folder";
        const dir = configTarget(v.client).dir;
        if (dir) mkdirSync(join(real, dir), { recursive: true });
        step = "file";
        writeFileSync(file, contents, { flag: "wx" });
        written.push({ path: file, role: "server", state: "written", contents });
        if (second) {
          step = "second";
          mkdirSync(dirname(second.path), { recursive: true });
          try {
            writeFileSync(second.path, second.contents, { flag: "wx" });
            written.push({ path: second.path, role: second.role, state: "written", contents: second.contents });
          } catch (error) {
            // Only an existing second file is a normal outcome: it is never changed, and the owner gets the exact text to add.
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            written.push({ path: second.path, role: second.role, state: "exists", contents: second.contents });
          }
        }
        brain.store.set(`agent_files:${grant.id}`, written);
      } catch (error) {
        if (step === "second") {
          try {
            unlinkSync(file);
          } catch {}
        }
        if (wroteKey) {
          try {
            unlinkSync(keyFile(grant.id));
          } catch {}
        }
        try {
          brain.revoke(p, grant.id);
        } catch {}
        if (step === "file" && (error as NodeJS.ErrnoException).code === "EEXIST")
          throw new BrainError("FILE_EXISTS", `BiBrain will not change your existing ${name}. Add the BiBrain lines to it yourself.`, 409);
        throw new BrainError(
          "WRITE_FAILED",
          `BiBrain could not write ${step === "second" ? (secondFileTarget(v.client)?.file.join("/") ?? name) : name} in that folder.`,
          500,
        );
      }
      return { connection_id: grant.id, file, contents, files: written };
    },
    forget(connectionId: string) {
      if (!z.uuid().safeParse(connectionId).success) return;
      brain.store.run("DELETE FROM settings WHERE key=?", `agent_files:${connectionId}`);
      try {
        if (lstatSync(keyFile(connectionId)).isFile()) unlinkSync(keyFile(connectionId));
      } catch {}
    },
  };
}
