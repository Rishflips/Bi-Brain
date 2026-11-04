import { useState } from "react";

export type AgentClient = "codex" | "claude-code" | "hermes" | "other";

export function clientLabel(client: AgentClient): string {
  return client === "codex" ? "Codex" : client === "claude-code" ? "Claude Code" : client === "hermes" ? "Hermes" : "your agent";
}

const HERMES_PLACEHOLDER = "https://your-bibrain-domain.example";
/** What Hermes needs on its own machine. The address is this BiBrain's HTTPS origin when it has one; a local address is replaced by a placeholder, because another server cannot reach it. Never contains a key. */
export function hermesSnippet(apiUrl: string) {
  const address = /^https:\/\//u.test(apiUrl) ? apiUrl.replace(/\/$/u, "") : HERMES_PLACEHOLDER;
  const yaml = ["mcp_servers:", "  bibrain:", `    url: "${address}/api/v1/agent/mcp"`, "    headers:", '      Authorization: "Bearer ${BRAIN_AGENT_TOKEN}"', "    tools:", "      prompts: false", "      resources: false", ""].join("\n");
  const env = `BRAIN_AGENT_TOKEN=<paste the key here>\nBRAIN_API_URL=${address}\n`;
  return { address, yaml, env };
}

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
        <label className="connection-choice">
          <input type="radio" name="agent-client" value="hermes" checked={value === "hermes"} onChange={() => onChange("hermes")} />
          <span>
            <strong>Hermes Agent (on a server)</strong>
            <small>Recall before each turn and a note after it, through a small plugin.</small>
          </span>
        </label>
        <label className="connection-choice">
          <input type="radio" name="agent-client" value="other" checked={value === "other"} onChange={() => onChange("other")} />
          <span>
            <strong>Another agent</strong>
            <small>Anything that can call an address or run a command.</small>
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
  onCopyText,
  onDone,
}: {
  client: AgentClient;
  token: string;
  apiUrl: string;
  busy: boolean;
  onCopyToken: () => void;
  onCopySetup: () => void;
  onCopyText: (text: string) => Promise<boolean>;
  onDone: () => void;
}) {
  const clientName = clientLabel(client);
  const local = client === "codex" || client === "claude-code";
  const [copyNote, setCopyNote] = useState("");
  const copyHermes = async (text: string, what: string) => {
    const ok = await onCopyText(text);
    setCopyNote(ok ? `${what} copied.` : "Copying did not work. Select the text above and copy it by hand.");
  };
  const hermes = client === "hermes" ? hermesSnippet(apiUrl) : null;
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
        {hermes ? (
          <>
            <li>
              <div>
                <span className="step-label">On the Hermes server, put two lines in ~/.hermes/.env</span>
                <p>Hermes usually runs on a server next to a self-hosted BiBrain, so the address is your BiBrain's HTTPS domain, not this computer.</p>
                <pre data-testid="hermes-env">{hermes.env}</pre>
                <button type="button" onClick={() => void copyHermes(hermes.env, "The two lines")} disabled={busy}>Copy the two lines</button>
              </div>
            </li>
            <li>
              <div>
                <span className="step-label">Add BiBrain's tools to ~/.hermes/config.yaml</span>
                <pre data-testid="hermes-config">{hermes.yaml}</pre>
                <button type="button" onClick={() => void copyHermes(hermes.yaml, "The config")} disabled={busy}>Copy the config</button>
              </div>
            </li>
            <li>
              <div>
                <span className="step-label">Turn on recall and session notes</span>
                <p>Copy the folder <code>integrations/hermes/bibrain</code> from BiBrain to <code>~/.hermes/plugins/bibrain</code> on the Hermes server, then run <code>hermes plugins enable bibrain</code>. It sends the first 500 characters of each turn and, after a reply, only its Decided, Open question and Next step lines. It never blocks a turn.</p>
              </div>
            </li>
          </>
        ) : null}
        {hermes && copyNote ? <li><p role="status" className="muted">{copyNote}</p></li> : null}
        {client === "other" ? (
          <li>
            <div>
              <span className="step-label">Connect it one of three ways</span>
              <p>Tools: point its MCP setting at <code>{apiUrl}/api/v1/agent/mcp</code> with the key as a bearer header, or run BiBrain's local connector. Recall and notes: call <code>/api/v1/agent/recall-push</code> and <code>/api/v1/agent/session-note</code>, or, on this computer, <code>bibrain recall</code> and <code>bibrain note</code> with a line of JSON. The exact shapes are in docs/CONNECT_ANY_AGENT.md in the BiBrain folder.</p>
            </div>
          </li>
        ) : null}
        {local ? (<>
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
        </>) : null}
      </ol>
      {local ? (
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
      ) : null}
      <button type="button" onClick={onDone}>
        Done
      </button>
    </div>
  );
}
