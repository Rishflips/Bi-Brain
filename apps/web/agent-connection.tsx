export type AgentClient = "codex" | "claude-code";

type ConnectionProject = { id: string; title: string };

export function AgentContinuityWorkspace({
  projects,
  projectId,
  projectTitle,
  originals,
  memories,
  openQuestions,
  goalTitle,
  connectedAgents,
  waitingAgents,
  hasReviewedContext,
  onProjectChange,
  onPreviewHandoff,
  onConnect,
  onSave,
  onReview,
}: {
  projects: ConnectionProject[];
  projectId: string;
  projectTitle: string;
  originals: number;
  memories: number;
  openQuestions: number;
  goalTitle: string | null;
  connectedAgents: number;
  waitingAgents: number;
  hasReviewedContext: boolean;
  onProjectChange: (projectId: string) => void;
  onPreviewHandoff: () => void;
  onConnect: () => void;
  onSave: () => void;
  onReview: () => void;
}) {
  const connectionSummary = connectedAgents
    ? `${connectedAgents} connected ${connectedAgents === 1 ? "agent" : "agents"}`
    : waitingAgents
      ? `${waitingAgents} waiting for first use`
      : "No agent using this project yet";

  return (
    <section
      className="agent-continuity"
      aria-labelledby="agent-continuity-title"
      data-ui="agent-continuity"
    >
      <header className="agent-continuity-heading">
        <div>
          <p className="section-kicker">ONE PROJECT, ANY AGENT</p>
          <h2 id="agent-continuity-title">Pick up anywhere.</h2>
          <p>
            Choose one project, then carry a reviewed snapshot or give a trusted
            agent temporary access. Nothing is shared automatically.
          </p>
        </div>
        <label className="connection-project-picker">
          <span>Project to continue</span>
          <select
            name="connection-project"
            value={projectId}
            onChange={(event) => onProjectChange(event.target.value)}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title}
              </option>
            ))}
          </select>
        </label>
      </header>

      <div className="connection-readiness" aria-live="polite">
        <span
          className={hasReviewedContext ? "is-ready" : "is-quiet"}
          aria-hidden="true"
        />
        <div>
          <strong>
            {hasReviewedContext
              ? `${projectTitle} has reviewed context.`
              : originals
                ? `${projectTitle} has saved originals. Review meaning before sharing it.`
                : `${projectTitle} needs a first memory.`}
          </strong>
          <p>{connectionSummary}</p>
        </div>
      </div>

      <dl className="connection-facts">
        <div>
          <dt>Reviewed memory</dt>
          <dd>{memories}</dd>
        </div>
        <div>
          <dt>Originals</dt>
          <dd>{originals}</dd>
        </div>
        <div>
          <dt>Open questions</dt>
          <dd>{openQuestions}</dd>
        </div>
        <div>
          <dt>Direction</dt>
          <dd>{goalTitle ?? "Not chosen"}</dd>
        </div>
      </dl>

      <div className="connection-paths">
        <article>
          <p className="section-kicker">ONE-TIME</p>
          <h3>Copy a reviewed handoff</h3>
          <p>
            See the exact understanding, questions, evidence, and direction
            before copying anything into a chat.
          </p>
          {hasReviewedContext ? (
            <button type="button" onClick={onPreviewHandoff}>
              Preview reviewed handoff
            </button>
          ) : originals ? (
            <button type="button" onClick={onReview}>
              Review before sharing
            </button>
          ) : (
            <button type="button" onClick={onSave}>
              Add something first
            </button>
          )}
          <small>No ongoing access is created.</small>
        </article>
        <article>
          <p className="section-kicker">CONTINUOUS</p>
          <h3>Keep an agent caught up</h3>
          <p>
            Grant time-limited access to this project. Private material stays
            excluded, and every connection can be revoked here.
          </p>
          <button type="button" className="primary" onClick={onConnect}>
            {connectedAgents ? "Connect another agent" : "Connect an agent"}
          </button>
          <small>Read-only is the default.</small>
        </article>
      </div>

      <ul className="connection-promises" aria-label="Connection protections">
        <li>Only the selected project</li>
        <li>Private originals stay private</li>
        <li>Revoke access at any time</li>
      </ul>
    </section>
  );
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
