import { useState } from "react";
import type { Source } from "../../packages/contracts/index.ts";
import { EvidenceList } from "./components.tsx";

/**
 * The persisted outcome of an inline first-note capture.
 *
 * `sourceId` is set the moment `/api/v1/sources` returns 201, because a 201
 * means the source row and its original version are already durably written.
 * Everything else is a *view* of that known-persisted note and may load later or
 * fail to load without ever changing the fact that it is saved.
 */
export type FirstNote = {
  sourceId: string;
  duplicate: boolean;
  quarantined: boolean;
  warning?: string;
  /** The actual returned source once it loads; never the raw draft. */
  source: Source | null;
  /**
   * A transient read failure. It never implies the note was not saved, but it
   * also must not be presented as the current version of the original.
   */
  sourceError: string | null;
  /** An explicit 404 / inactive state: the body is gone and must not linger. */
  removed: boolean;
};

/**
 * Zero-setup inline capture on Today. The draft lives in this component so a
 * failed save can never discard what the user typed.
 */
export function FirstNoteComposer({
  providerEnabled,
  onSave,
  onTryExample,
}: {
  providerEnabled: boolean;
  onSave: (draft: { body: string }) => Promise<void>;
  onTryExample: () => void;
}) {
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState("");
  const canSave = body.trim().length > 0 && !saving;
  const submit = async () => {
    if (!canSave) return;
    if (
      Array.from(body).length > 100000 ||
      new TextEncoder().encode(body).byteLength > 1048576
    ) {
      setFailure(
        "Use up to 100,000 characters and 1 MiB per note. Split longer material into separate notes.",
      );
      return;
    }
    setFailure("");
    setSaving(true);
    try {
      await onSave({ body });
    } catch (e) {
      // The draft stays exactly as typed; only the error is added.
      setFailure(
        e instanceof Error
          ? e.message
          : "Your note could not be saved. Nothing was changed.",
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <article className="first-note" data-ui="save-composer">
      <h2>Drop it here. Pick it up anywhere.</h2>
      <p>
        Paste a note, decision, plan, or conversation. BiBrain keeps the
        original and makes it easy to continue from any connected agent.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="field" htmlFor="first-note-body">
          Write a note
        </label>
        <textarea
          id="first-note-body"
          aria-label="Write a note"
          aria-describedby="first-note-limit"
          rows={6}
          maxLength={200000}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            // Keyboard-first capture: submit without leaving the field.
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder="Paste a note, decision, plan, or conversation…"
        />
        <p id="first-note-limit" className="muted">
          Up to 100,000 characters and 1 MiB per note. Ctrl or ⌘ + Enter to
          save.
        </p>
        {failure ? (
          <p className="alert" role="alert">
            {failure} Your draft is still here.
          </p>
        ) : null}
        <div className="actions">
          <button className="primary" type="submit" disabled={!canSave}>
            Save to my brain
          </button>
          <button type="button" onClick={onTryExample}>
            Try an example
          </button>
        </div>
        <p className="muted">
          {providerEnabled
            ? "AI preparation is available. You control what it can use under Settings."
            : "Private local preview · nothing is sent to an AI provider."}
        </p>
      </form>
    </article>
  );
}

/**
 * Durable saved confirmation. The "saved" acknowledgement comes from the real
 * 201 `source_id`, not from a queue, a preparation job or a later read. The note
 * body is only ever rendered from the actual returned source (so a quarantined
 * suspected secret is shown as the sanitized stored version, never echoed from
 * the draft).
 *
 * `previewItems` are pre-filtered by the caller so an item is shown only when
 * EVERY one of its evidence entries points at this exact source id AND version;
 * a project-wide brief that happens to include this note can never have
 * other-source clauses misattributed to it.
 */
export function FirstNoteSaved({
  note,
  projectName,
  previewMode,
  previewItems,
  workerOnline,
  onRetryOpen,
  onFind,
  onOpen,
  onOpenEvidence,
  onSaveAnother,
}: {
  note: FirstNote;
  projectName: (id: string) => string;
  previewMode: string | null;
  previewItems: any[];
  workerOnline: boolean;
  onRetryOpen: () => void;
  onFind: () => void;
  onOpen: () => void;
  onOpenEvidence: (id: string) => void;
  onSaveAnother: () => void;
}) {
  if (note.removed)
    return (
      <article className="saved-note removed">
        <p className="alert" role="alert">
          This note is no longer available in active use here, so its text is
          not shown. Nothing was restored.
        </p>
        <div className="actions">
          <button className="primary" type="button" onClick={onSaveAnother}>
            Save something new
          </button>
        </div>
      </article>
    );

  const source = note.source;
  return (
    <article className="saved-note" data-ui="saved-receipt">
      <p className="status saved" role="status">
        <span className="tick" aria-hidden="true">
          ✓
        </span>
        {note.duplicate
          ? "Saved to your brain. This exact text was already saved, so your existing original is shown."
          : "Saved to your brain."}
      </p>
      {note.quarantined ? (
        <p className="alert" role="alert">
          {note.warning ??
            "Suspected secret retained in protected quarantine; excluded from previews, agents and models."}
        </p>
      ) : null}
      {!note.duplicate ? (
        <p className="muted">
          Your original was written to durable storage before any preparation.
        </p>
      ) : null}

      {source ? (
        <>
          <h3>{source.title}</h3>
          <p className="muted">
            {projectName(source.project_id)} ·{" "}
            {new Date(source.captured_at).toLocaleString()} · original version{" "}
            {source.version} ·{" "}
            {source.visibility === "private"
              ? "only you"
              : "shareable within this project"}
          </p>
          {note.sourceError ? (
            <p className="muted">
              We couldn’t confirm the latest version just now. The text below is
              the last version we loaded.
            </p>
          ) : null}
          <details open>
            <summary>
              {note.sourceError ? "Last loaded original" : "Retained original"}
            </summary>
            <pre data-testid="first-note-original">{source.body}</pre>
          </details>
        </>
      ) : note.sourceError ? (
        <>
          <p className="alert" role="alert">
            Your note is saved. We couldn’t load its text here:{" "}
            {note.sourceError}
          </p>
          <button type="button" onClick={onRetryOpen}>
            Try opening again
          </button>
        </>
      ) : (
        <p className="muted">Loading your saved original…</p>
      )}

      <hr />
      <h3>Source-linked preview</h3>
      {previewItems.length ? (
        <>
          <p className="pill">{previewMode ?? "Extractive preview"}</p>
          <p className="muted">
            Passages drawn from this exact saved original; each links back to
            it.
          </p>
          {previewItems.map((item: any, index: number) => (
            <div key={index}>
              <p>
                {item.epistemic_status === "user_assertion" ? (
                  <strong>Your understanding: </strong>
                ) : item.epistemic_status === "hypothesis" ? (
                  <strong>Hypothesis: </strong>
                ) : null}
                {item.text}
              </p>
              <EvidenceList items={item.evidence} onOpen={onOpenEvidence} />
            </div>
          ))}
        </>
      ) : source ? (
        <p className="muted">
          {workerOnline
            ? "Your note is saved. The source-linked preview is not ready yet — it will appear here when preparation finishes."
            : "Your note is saved. Local preparation is offline, so a source-linked preview is not available yet."}
        </p>
      ) : (
        <p className="muted">
          Your note is saved. Open it again to see its source-linked preview.
        </p>
      )}

      <div className="actions">
        <button className="primary" type="button" onClick={onFind}>
          Find in Your brain
        </button>
        {source ? (
          <button type="button" onClick={onOpen}>
            Open this note
          </button>
        ) : null}
        <button type="button" onClick={onSaveAnother}>
          Save another
        </button>
      </div>
    </article>
  );
}
