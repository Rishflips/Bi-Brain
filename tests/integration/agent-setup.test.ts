import { describe, expect, it } from "vitest";
import { posix, win32 } from "node:path";
import { AGENT_HINTS, checkFolderShape, configContents, configTarget, detectAgents } from "../../packages/domain/agents.ts";

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
