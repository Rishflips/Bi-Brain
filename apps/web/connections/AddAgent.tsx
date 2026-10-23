import { useState } from "react";
import { friendlyError } from "../today/BriefCard.tsx";
import type { AgentInfo, Api, Preview } from "./types.ts";

type Props = {
  api: Api;
  info: AgentInfo;
  projects: { id: string; title: string }[];
  projectId: string;
  lastFolder: string;
  onCancel: () => void;
  onAdded: () => Promise<void>;
};

export function AddAgent({ api, info, projects, projectId, lastFolder, onCancel, onAdded }: Props) {
  const [project, setProject] = useState(projectId);
  const [folder, setFolder] = useState(lastFolder);
  const [access, setAccess] = useState<"suggest" | "read">("suggest");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = (s: string) => `cx-${info.client}-${s}`;

  async function loadPreview(): Promise<Preview | null> {
    setError(null);
    try {
      const p = await api<Preview>("/agents/preview", { client: info.client, project_id: project, folder });
      setPreview(p);
      return p;
    } catch (e) {
      setPreview(null);
      setError(friendlyError(e));
      return null;
    }
  }

  async function add() {
    if (busy) return;
    setBusy(true);
    try {
      const p = preview ?? (await loadPreview());
      if (!p) return;
      if (p.exists) {
        setError(`BiBrain will not change your existing ${info.file}. Add the lines below to it yourself.`);
        return;
      }
      await api("/agents/connect", { connection_id: p.connection_id, client: info.client, project_id: project, folder, access });
      await onAdded();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="cx-add"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <div className="cx-field">
        <label htmlFor={id("project")}>Project</label>
        <select id={id("project")} value={project} onChange={(e) => { setProject(e.target.value); setPreview(null); }}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
      </div>
      <label className="cx-field" htmlFor={id("folder")}>
        <span>Project folder on this computer</span>
        <input
          id={id("folder")}
          type="text"
          required
          maxLength={1000}
          value={folder}
          placeholder="C:\Users\you\code\northstar"
          onChange={(e) => { setFolder(e.target.value); setPreview(null); }}
        />
        <small className="tv-faint">The folder where you open {info.name}.</small>
      </label>
      <fieldset className="cx-field">
        <legend>What may it do?</legend>
        <label>
          <input type="radio" name={id("access")} checked={access === "suggest"} onChange={() => setAccess("suggest")} /> Read and suggest (recommended). Suggestions wait on Today.
        </label>
        <label>
          <input type="radio" name={id("access")} checked={access === "read"} onChange={() => setAccess("read")} /> Read only. It never writes anything.
        </label>
      </fieldset>
      <details
        onToggle={(e) => {
          if ((e.currentTarget as HTMLDetailsElement).open && !preview && folder.trim()) void loadPreview();
        }}
      >
        <summary>See the file BiBrain will add</summary>
        {preview ? (
          <>
            <p className="tv-faint">{preview.file}</p>
            <pre className="cx-file" data-testid="agent-file">
              {preview.contents}
            </pre>
            <p className="tv-faint">The access key stays in BiBrain on this computer, never in this file. An existing file is never changed.</p>
          </>
        ) : (
          <p className="tv-faint">Enter the project folder to see the file.</p>
        )}
      </details>
      {error && (
        <div className="tv-error" role="alert">
          <p>{error}</p>
          {preview?.exists && (
            <pre className="cx-file" data-testid="agent-file-to-add">
              {preview.contents}
            </pre>
          )}
        </div>
      )}
      <div className="tv-actions">
        <button type="submit" className="tv-btn tv-primary tv-sm" disabled={busy || !folder.trim()}>
          Add to {info.name}
        </button>
        <button type="button" className="tv-btn tv-ghost tv-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
