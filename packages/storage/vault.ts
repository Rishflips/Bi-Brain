import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
  readdirSync,
  rmSync,
  openSync,
  closeSync,
  statSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { detectSecrets, scannerVersion } from "./secrets.ts";
export type PortableState = {
  projects: any[];
  sources: any[];
  source_versions: any[];
  entities: any[];
  entity_versions: any[];
};
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const fileId = (value: string) => {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(value))
    throw new Error("Unsafe portable record ID");
  return value;
};
export class Vault {
  readonly root: string;
  readonly protectedRoot: string;
  private lockDepth = 0;
  constructor(
    root: string,
    readonly fault?: (step: string) => void,
  ) {
    this.root = resolve(root);
    this.protectedRoot = this.root + "-protected";
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    mkdirSync(this.protectedRoot, { recursive: true, mode: 0o700 });
    mkdirSync(join(this.protectedRoot, "raw", "quarantine"), {
      recursive: true,
      mode: 0o700,
    });
    this.withLock(() => {
      if (!existsSync(join(this.root, ".git"))) this.git("init", "-b", "main");
      writeFileSync(
        join(this.root, "bi-brain-vault.md"),
        "# Bi Brain vault v1\n\nmanifest.json names the complete committed generation. Read its state.json and Markdown files; do not combine generations. Raw source versions are immutable UTF-8 originals. Quarantine and credentials are outside this Git root. Private records are owner-only; portable does not mean public. External edits are proposals, never direct authority. Permanent forgetting sanitizes retained generations and Git history; unmanaged copies cannot be recalled.\n",
      );
    });
  }
  git(...args: string[]) {
    return execFileSync(
      "git",
      [
        "-c",
        "user.name=Bi Brain Vault",
        "-c",
        "user.email=vault@localhost",
        ...args,
      ],
      {
        cwd: this.root,
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  }
  withLock<T>(fn: () => T): T {
    if (this.lockDepth) return fn();
    const path = join(this.protectedRoot, "write.lock");
    const until = Date.now() + 10000;
    while (true) {
      try {
        const fd = openSync(path, "wx", 0o600);
        writeFileSync(fd, String(process.pid));
        closeSync(fd);
        break;
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
        let pid = 0;
        let age = 0;
        try {
          pid = Number(readFileSync(path, "utf8"));
          age = Date.now() - statSync(path).mtimeMs;
        } catch (readError: any) {
          if (!["EPERM", "EACCES", "ENOENT", "EBUSY"].includes(readError?.code))
            throw readError;
        }
        let alive = false;
        if (Number.isSafeInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
            alive = true;
          } catch {}
        }
        if (!alive && age > 1000) {
          try {
            rmSync(path, { force: true });
            continue;
          } catch (removeError: any) {
            if (
              !["EPERM", "EACCES", "ENOENT", "EBUSY"].includes(
                removeError?.code,
              )
            )
              throw removeError;
          }
        }
        if (Date.now() > until)
          throw new Error(
            "Vault writer is busy; retry after the other process completes.",
          );
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    this.lockDepth++;
    try {
      return fn();
    } finally {
      this.lockDepth--;
      rmSync(path, { force: true });
    }
  }
  capture(id: string, version: number, body: string, forceQuarantine = false) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error("Invalid raw ID");
    const reasons = detectSecrets(body);
    if (forceQuarantine && !reasons.length) reasons.push("sensitive_metadata");
    const dir = reasons.length
      ? join(this.protectedRoot, "raw", "quarantine")
      : join(this.protectedRoot, "raw");
    const file = join(dir, `${id}-v${version}.txt`);
    if (!existsSync(file))
      writeFileSync(file, body, { flag: "wx", mode: 0o600 });
    else if (readFileSync(file, "utf8") !== body)
      throw new Error("Original raw version is immutable");
    return {
      quarantined: reasons.length > 0,
      reasons,
      hash: digest(body),
      scanner_version: scannerVersion,
    };
  }
  stage(state: PortableState) {
    const body = JSON.stringify(state);
    if (detectSecrets(body).length)
      throw new Error("Vault publication blocked by secret scanner");
    const generation = randomUUID();
    const journal = { generation, hash: digest(body), state };
    const path = join(this.protectedRoot, "journal.json");
    writeFileSync(path + ".tmp", JSON.stringify(journal), { mode: 0o600 });
    renameSync(path + ".tmp", path);
    this.fault?.("staged");
    return journal;
  }
  publish(journal: ReturnType<Vault["stage"]>) {
    const dir = join(this.root, "generations", journal.generation);
    mkdirSync(dir, { recursive: true });
    for (const name of [
      "raw",
      "wiki",
      "claims",
      "identity",
      "intent",
      "links",
      "handoff",
      "dreams",
      "tombstones",
    ])
      mkdirSync(join(dir, name), { recursive: true });
    const state = journal.state;
    writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
    for (const s of state.sources) {
      fileId(s.id);
      fileId(s.project_id);
      if (s.state === "deleted") {
        writeFileSync(
          join(dir, "tombstones", `${s.id}.json`),
          JSON.stringify({
            id: s.id,
            generation: journal.generation,
            state: "deleted",
          }),
        );
        continue;
      }
      for (const v of state.source_versions.filter(
        (v) => v.source_id === s.id,
      )) {
        writeFileSync(join(dir, "raw", `${s.id}-v${v.version}.txt`), v.body);
        writeFileSync(
          join(dir, "raw", `${s.id}-v${v.version}.json`),
          JSON.stringify({
            ...s,
            ...v,
            content_hash: digest(v.body),
            source_time: v.created_at,
            ingestion_time: s.captured_at,
          }),
        );
      }
    }
    for (const e of state.entities) {
      fileId(e.id);
      fileId(e.project_id);
      const data = JSON.parse(e.data);
      const folder =
        e.kind === "goal" || e.kind === "intent"
          ? "intent"
          : e.kind === "claim"
            ? "claims"
            : e.kind === "receipt"
              ? "dreams"
              : e.kind === "handoff"
                ? "handoff"
                : e.kind === "link"
                  ? "links"
                  : "wiki";
      writeFileSync(
        join(dir, folder, `${e.id}.json`),
        JSON.stringify(e, null, 2),
      );
      writeFileSync(
        join(dir, folder, `${e.id}.md`),
        `---\nid: ${e.id}\nproject: ${e.project_id}\nversion: ${e.version}\n---\n# ${data.title ?? e.kind}\n\n${data.plan ?? data.artifact ?? data.text ?? data.items?.map((i: any) => i.text).join("\n\n") ?? ""}\n\n## Provenance\n\nSee the adjacent JSON for exact source versions, spans, status and history.\n`,
      );
      if (e.kind === "handoff" && data.status === "current") {
        const projectDir = join(dir, "handoff", e.project_id);
        mkdirSync(projectDir, { recursive: true });
        writeFileSync(join(projectDir, "current.md"), data.text);
      }
    }
    const byDay = new Map<string, string[]>();
    for (const receipt of state.entities.filter((e) => e.kind === "receipt")) {
      const day = String(receipt.created_at).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const data = JSON.parse(receipt.data);
      const lines = byDay.get(day) ?? [];
      lines.push(
        [
          `## Run ${data.job_id ?? receipt.id}`,
          `- Project: ${receipt.project_id}`,
          `- Outcome: ${data.outcome ?? "unknown"}`,
          `- Reason: ${data.reason ?? ""}`,
          `- Input hash: ${data.input_hash ?? "unrecorded"}`,
          `- Provider: ${data.provider ?? "offline"}`,
          `- Policy: ${data.policy_version ?? "unrecorded"}`,
          `- Usage: ${data.usage_status ?? "not_applicable"}`,
          `- Cost (micro USD): ${data.cost_micro_usd ?? 0}`,
          `- Result: ${data.result_id ?? "none"}`,
          `- Evidence: ${(data.goal_evidence ?? data.evidence ?? []).map((ref: any) => `${ref.source_id} v${ref.source_version}`).join(", ") || "none"}`,
          "",
        ].join("\n"),
      );
      byDay.set(day, lines);
    }
    for (const [day, lines] of byDay)
      writeFileSync(
        join(dir, "dreams", `${day}.md`),
        `# Dream receipts — ${day}\n\n${lines.join("\n")}`,
      );
    this.fault?.("files_written");
    const manifest = {
      schema_version: 1,
      generation: journal.generation,
      state_hash: journal.hash,
      published_at: new Date().toISOString(),
      state: `generations/${journal.generation}/state.json`,
    };
    writeFileSync(
      join(this.root, "manifest.next"),
      JSON.stringify(manifest, null, 2),
    );
    renameSync(
      join(this.root, "manifest.next"),
      join(this.root, "manifest.json"),
    );
    this.fault?.("manifest_published");
    // The manifest names the only live generation. Older snapshots remain in
    // local Git history until an explicit permanent-forget sanitation.
    const generations = join(this.root, "generations");
    for (const name of readdirSync(generations))
      if (name !== journal.generation)
        rmSync(join(generations, name), { recursive: true, force: true });
    this.git("add", ".");
    this.git(
      "commit",
      "--allow-empty",
      "-m",
      `Publish generation ${journal.generation}`,
    );
    rmSync(join(this.protectedRoot, "journal.json"), { force: true });
    return manifest;
  }
  read(): PortableState {
    const m = JSON.parse(
      readFileSync(join(this.root, "manifest.json"), "utf8"),
    );
    if (!/^generations\/[a-f0-9-]+\/state.json$/.test(m.state))
      throw new Error("Invalid generation path");
    const body = readFileSync(join(this.root, m.state), "utf8");
    const state = JSON.parse(body);
    if (digest(JSON.stringify(state)) !== m.state_hash)
      throw new Error("Vault hash mismatch; external edits require review");
    return state;
  }
  generation() {
    return JSON.parse(readFileSync(join(this.root, "manifest.json"), "utf8"))
      .generation as string;
  }
  recover() {
    const path = join(this.protectedRoot, "journal.json");
    if (existsSync(path)) this.publish(JSON.parse(readFileSync(path, "utf8")));
  }
  forget(id: string, state: PortableState) {
    this.markPendingForget(id);
    for (const dir of [
      join(this.protectedRoot, "raw"),
      join(this.protectedRoot, "raw", "quarantine"),
    ])
      for (const name of readdirSync(dir))
        if (name.startsWith(id + "-v")) rmSync(join(dir, name));
    this.sanitizeManagedHistory(state);
  }
  markPendingForget(id: string) {
    fileId(id);
    writeFileSync(
      join(this.protectedRoot, "sanitize.pending"),
      JSON.stringify({ source_id: id }),
      { mode: 0o600 },
    );
  }
  sanitizeManagedHistory(state: PortableState) {
    // Erase retired derived disclosures or permanently forgotten evidence from local managed history.
    const pending = join(this.protectedRoot, "sanitize.pending");
    if (!existsSync(pending))
      writeFileSync(pending, JSON.stringify({ reason: "history" }), {
        mode: 0o600,
      });
    this.publish(this.stage(state));
    const currentGeneration = this.generation();
    const generations = join(this.root, "generations");
    if (existsSync(generations))
      for (const dir of readdirSync(generations))
        if (dir !== currentGeneration)
          rmSync(join(generations, dir), { recursive: true, force: true });
    this.git("checkout", "--orphan", `sanitized-${randomUUID()}`);
    this.git("add", ".");
    this.git(
      "commit",
      "-m",
      "Permanent forgetting: retained history sanitized",
    );
    const current = this.git("branch", "--show-current");
    for (const branch of this.git(
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
    ).split("\n"))
      if (branch !== current) this.git("branch", "-D", branch);
    this.git("reflog", "expire", "--expire=now", "--all");
    this.git("gc", "--prune=now");
    rmSync(pending, { force: true });
  }
  verifyForget(id: string) {
    fileId(id);
    const rawNames = [
      join(this.protectedRoot, "raw"),
      join(this.protectedRoot, "raw", "quarantine"),
    ].flatMap((dir) =>
      readdirSync(dir).filter((name) => name.startsWith(`${id}-v`)),
    );
    const generations = join(this.root, "generations");
    const retainedRaw = existsSync(generations)
      ? readdirSync(generations).flatMap((generation) => {
          const raw = join(generations, generation, "raw");
          return existsSync(raw)
            ? readdirSync(raw).filter((name) => name.startsWith(`${id}-v`))
            : [];
        })
      : [];
    const reachableHistory = this.git(
      "log",
      "--all",
      "--name-only",
      "--format=",
    )
      .split("\n")
      .some((name) => name.includes(`${id}-v`));
    const unreachableObjects =
      this.git("fsck", "--full", "--no-reflogs", "--unreachable").trim()
        .length > 0;
    return {
      file_gone:
        rawNames.length === 0 &&
        retainedRaw.length === 0 &&
        !reachableHistory &&
        !unreachableObjects,
      evidence: {
        protected_raw_versions: rawNames.length,
        generation_raw_versions: retainedRaw.length,
        managed_history_references: reachableHistory,
        unreachable_git_objects: unreachableObjects,
      },
    };
  }
}
