import { describe, expect, it } from "vitest";
import { posix, win32 } from "node:path";
import { AGENT_HINTS, CODEX_HOOKS_CONFIRMED, CURSOR_RULE, PREAPPROVED_TOOLS, agentHint, checkFolderShape, configContents, configTarget, detectAgents, forwardSlashes, hookCommand, secondFileContents, secondFileTarget } from "../../packages/domain/agents.ts";
import { detectSecrets } from "../../packages/storage/secrets.ts";

const launch = {
  node: "C:\\Program Files\\nodejs\\node.exe",
  cli: "C:\\Users\\Ana\\Bi Brain\\apps\\cli\\bibrain.mjs",
  connectionId: "1b4e28ba-2fa1-41d2-883f-0016d3cca427",
  dataDir: "C:\\Users\\Ana\\Bi Brain\\data",
};

describe("configContents", () => {
  it("writes a Codex project file with escaped Windows paths and no key", () => {
    const text = configContents("codex", launch);
    expect(configTarget("codex")).toEqual({ dir: ".codex", file: [".codex", "config.toml"] });
    expect(text).toBe(
      [
        "# Added by BiBrain. The access key stays in BiBrain on this computer, not in this file.",
        "[mcp_servers.bibrain]",
        'command = "C:\\\\Program Files\\\\nodejs\\\\node.exe"',
        'args = ["C:\\\\Users\\\\Ana\\\\Bi Brain\\\\apps\\\\cli\\\\bibrain.mjs", "connect", "--connection", "1b4e28ba-2fa1-41d2-883f-0016d3cca427", "--data", "C:\\\\Users\\\\Ana\\\\Bi Brain\\\\data"]',
        "startup_timeout_sec = 15",
        "tool_timeout_sec = 60",
        "required = false",
        'default_tools_approval_mode = "writes"',
        "",
      ].join("\n"),
    );
  });

  it("writes the same launch for Claude Code and Cursor as JSON", () => {
    for (const client of ["claude-code", "cursor"] as const) {
      const parsed = JSON.parse(configContents(client, launch));
      expect(parsed).toEqual({
        mcpServers: {
          bibrain: {
            command: launch.node,
            args: [launch.cli, "connect", "--connection", launch.connectionId, "--data", launch.dataDir],
          },
        },
      });
    }
    expect(configTarget("claude-code")).toEqual({ dir: null, file: [".mcp.json"] });
    expect(configTarget("cursor")).toEqual({ dir: ".cursor", file: [".cursor", "mcp.json"] });
    expect(Object.keys(AGENT_HINTS).sort()).toEqual(["claude-code", "codex", "cursor"]);
  });
});

describe("detectAgents", () => {
  it("finds a Windows command on PATH and a config folder in the home folder", () => {
    const present = new Set(["C:\\tools\\codex.cmd", "C:\\Users\\Ana\\.cursor"]);
    const found = detectAgents({
      home: "C:\\Users\\Ana",
      pathDirs: ["C:\\tools", ""],
      platform: "win32",
      exists: (p) => present.has(p),
      join: win32.join,
    });
    expect(found).toEqual({ codex: true, "claude-code": false, cursor: true });
  });

  it("accepts a PATH entry wrapped in double quotes on Windows", () => {
    const found = detectAgents({
      home: "C:\\Users\\Ana",
      pathDirs: ['"C:\\tools"'],
      platform: "win32",
      exists: (p) => p === "C:\\tools\\codex.cmd",
      join: win32.join,
    });
    expect(found).toEqual({ codex: true, "claude-code": false, cursor: false });
  });

  it("finds a posix binary without an extension", () => {
    const found = detectAgents({
      home: "/home/ana",
      pathDirs: ["/usr/local/bin"],
      platform: "linux",
      exists: (p) => p === "/usr/local/bin/claude",
      join: posix.join,
    });
    expect(found).toEqual({ codex: false, "claude-code": true, cursor: false });
  });
});

describe("checkFolderShape", () => {
  it("accepts an absolute folder and explains every refusal in one sentence", () => {
    expect(checkFolderShape("C:\\work\\northstar", win32.isAbsolute)).toBeNull();
    expect(checkFolderShape("/home/ana/northstar", posix.isAbsolute)).toBeNull();
    expect(checkFolderShape("northstar", posix.isAbsolute)).toBe("Use the full path of the project folder, for example C:\\Users\\you\\code\\northstar.");
    expect(checkFolderShape("/home/ana/../etc", posix.isAbsolute)).toBe("Use the folder's own path without .. in it.");
    expect(checkFolderShape("C:\\work\\..\\etc", win32.isAbsolute)).toBe("Use the folder's own path without .. in it.");
    expect(checkFolderShape("   ", posix.isAbsolute)).toBe("Enter the project folder.");
    expect(checkFolderShape("/" + "a".repeat(1000), posix.isAbsolute)).toBe("That folder path is too long.");
    expect(checkFolderShape("/home/ana/\u0000x", posix.isAbsolute)).toBe("That folder path has a character BiBrain cannot use.");
  });
});

describe("second files", () => {
  it("writes the Claude Code hook file with an unquoted first token, forward-slashed double-quoted arguments, two pre-approved read tools and no SessionStart", () => {
    expect(forwardSlashes("C:\\Program Files\\nodejs\\node.exe")).toBe("C:/Program Files/nodejs/node.exe");
    // A Node path with a space is not used as the first token: the bare word `node` is, so the line never starts with a quote.
    expect(hookCommand("claude-code", launch)).toBe(
      'node "C:/Users/Ana/Bi Brain/apps/cli/bibrain.mjs" hook claude-code --connection 1b4e28ba-2fa1-41d2-883f-0016d3cca427 --data "C:/Users/Ana/Bi Brain/data"',
    );
    expect(hookCommand("claude-code", { ...launch, node: "C:\\nodejs\\node.exe" })).toBe(
      'C:/nodejs/node.exe "C:/Users/Ana/Bi Brain/apps/cli/bibrain.mjs" hook claude-code --connection 1b4e28ba-2fa1-41d2-883f-0016d3cca427 --data "C:/Users/Ana/Bi Brain/data"',
    );
    expect(hookCommand("codex", { ...launch, node: "/usr/local/bin/node" }).startsWith('/usr/local/bin/node "')).toBe(true);
    // Anything a shell would split or interpret in the Node path also falls back to the bare word, and no command ever starts with a quote.
    for (const node of ["C:\\Program Files\\nodejs\\node.exe", "C:\\a&b\\node.exe", "C:\\100%\\node.exe", "C:\\x(1)\\node.exe"]) {
      const command = hookCommand("claude-code", { ...launch, node });
      expect(command.startsWith("node ")).toBe(true);
      expect(command[0]).not.toBe('"');
    }
    expect(secondFileTarget("claude-code")).toEqual({ dir: ".claude", file: [".claude", "settings.local.json"], role: "hook" });
    const text = secondFileContents("claude-code", launch)!;
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({
      permissions: { allow: ["mcp__bibrain__brain_recall", "mcp__bibrain__brain_open"] },
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: hookCommand("claude-code", launch), timeout: 5 }] }] },
    });
    expect(PREAPPROVED_TOOLS).toEqual(["mcp__bibrain__brain_recall", "mcp__bibrain__brain_open"]);
    expect(text).not.toContain("SessionStart");
    expect(text).not.toMatch(/brain_note|brain_propose|brain_forget|brain_link|brain_intent/);
    expect(text.endsWith("\n")).toBe(true);
    expect(detectSecrets(text)).toEqual([]);
  });
  it("writes the Cursor rule file and only writes a Codex hook file when its shape was confirmed", () => {
    expect(secondFileTarget("cursor")).toEqual({ dir: ".cursor", file: [".cursor", "rules", "bibrain.mdc"], role: "rule" });
    expect(secondFileContents("cursor", launch)).toBe(CURSOR_RULE);
    expect(CURSOR_RULE.startsWith("---\ndescription: Consult the owner's BiBrain before answering about their projects, people, decisions or preferences\nalwaysApply: true\n---\n")).toBe(true);
    expect(CURSOR_RULE).toContain("A no_match result means it is not recorded: say so instead of guessing.");
    if (CODEX_HOOKS_CONFIRMED) {
      expect(secondFileTarget("codex")).toEqual({ dir: ".codex", file: [".codex", "hooks.json"], role: "hook" });
      expect(JSON.parse(secondFileContents("codex", launch)!).hooks.UserPromptSubmit[0].hooks[0].command).toContain(" hook codex ");
      expect(agentHint("codex")).toContain("If Codex asks about hooks, allow BiBrain's.");
    } else {
      expect(secondFileTarget("codex")).toBeNull();
      expect(secondFileContents("codex", launch)).toBeNull();
      expect(agentHint("codex")).toBe(AGENT_HINTS.codex);
    }
  });
});
