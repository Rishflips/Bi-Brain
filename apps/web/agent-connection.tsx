export type AgentClient = "codex" | "claude-code";

export function agentSetupCommand(client: AgentClient, apiUrl: string) {
  const shared = `$env:BRAIN_AGENT_TOKEN = Read-Host "Paste the BiBrain connection key"\n$env:BRAIN_API_URL = "${apiUrl}"`;
  if (client === "claude-code") {
    return `${shared}\nclaude mcp add --scope local bibrain -- node node_modules/tsx/dist/cli.mjs apps/mcp/main.ts\nclaude`;
  }
  return `${shared}\nif (Test-Path .codex/config.toml) { Write-Host "Existing Codex project settings kept. Compare them with .codex/config.toml.example if BiBrain is not listed." } else { Copy-Item -Path .codex/config.toml.example -Destination .codex/config.toml }\ncodex`;
}

export function AgentClientPicker({
  value,
  onChange,
}: {
  value: AgentClient;
  onChange: (client: AgentClient) => void;
}) {
  return (
    <fieldset className="connection-picker">
      <legend>Where do you want to use your brain?</legend>
      <div className="connection-choice-grid">
        <label className="connection-choice">
          <input
            type="radio"
            name="agent-client"
            value="codex"
            checked={value === "codex"}
            onChange={() => onChange("codex")}
          />
          <span>
            <strong>Codex</strong>
            <small>
              Continue in Codex, its IDE extension, or ChatGPT desktop.
            </small>
          </span>
        </label>
        <label className="connection-choice">
          <input
            type="radio"
            name="agent-client"
            value="claude-code"
            checked={value === "claude-code"}
            onChange={() => onChange("claude-code")}
          />
          <span>
            <strong>Claude Code</strong>
            <small>Use the same selected memory in this project.</small>
          </span>
        </label>
      </div>
    </fieldset>
  );
}

export function AgentSetupGuide({
  client,
  token,
  apiUrl,
  busy,
  onCopyToken,
  onCopySetup,
  onDone,
}: {
  client: AgentClient;
  token: string;
  apiUrl: string;
  busy: boolean;
  onCopyToken: () => void;
  onCopySetup: () => void;
  onDone: () => void;
}) {
  const clientName = client === "codex" ? "Codex" : "Claude Code";
  return (
    <div className="connection-setup" data-ui="agent-setup-guide">
      <div className="connection-created" role="status">
        <span aria-hidden="true">✓</span>
        <div>
          <strong>Private access is ready</strong>
          <p>It becomes Connected only after {clientName} uses BiBrain.</p>
        </div>
      </div>
      <ol className="setup-steps">
        <li>
          <div>
            <span className="step-label">Copy the one-time key</span>
            <p>
              BiBrain stores only a protected fingerprint and cannot show it
              again.
            </p>
            <pre data-testid="agent-connection-key">{token}</pre>
            <button type="button" onClick={onCopyToken} disabled={busy}>
              Copy connection key
            </button>
          </div>
        </li>
        <li>
          <div>
            <span className="step-label">Open a private PowerShell here</span>
            <p>
              Copy this safe setup. It asks for the key privately and does not
              place it in a file, URL, or command history.
            </p>
            <button
              type="button"
              className="primary"
              onClick={onCopySetup}
              disabled={busy}
            >
              Copy {clientName} setup
            </button>
          </div>
        </li>
        <li>
          <div>
            <span className="step-label">Paste and press Enter</span>
            <p>
              Paste the setup into PowerShell in this BiBrain folder. When
              asked, paste the connection key. Then start working normally in{" "}
              {clientName}.
            </p>
          </div>
        </li>
      </ol>
      <details>
        <summary>Review the setup before copying</summary>
        <pre data-testid="agent-setup-command">
          {agentSetupCommand(client, apiUrl)}
        </pre>
        <p className="muted">
          This command contains no connection key. Revoke access from
          Connections whenever you finish.
        </p>
      </details>
      <button type="button" onClick={onDone}>
        Done
      </button>
    </div>
  );
}
