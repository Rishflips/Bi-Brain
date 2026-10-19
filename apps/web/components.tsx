import { useState } from "react";
import type { Entity, Evidence } from "../../packages/contracts/index.ts";
import { BrainEmblem } from "./brand.tsx";

type BrainPulseState =
  | "ready"
  | "attention"
  | "organizing"
  | "refreshing"
  | "offline"
  | "resting"
  | "caught-up";

export function BrainPulse({
  hasSavedWork,
  readyCount,
  hasActiveJobs,
  hasStaleUnderstanding,
  preparationEnabled,
  workerOnline,
}: {
  hasSavedWork: boolean;
  readyCount: number;
  hasActiveJobs: boolean;
  hasStaleUnderstanding: boolean;
  preparationEnabled: boolean;
  workerOnline: boolean;
}) {
  let state: BrainPulseState;
  let label: string;
  let title: string;
  let detail: string;

  if (!hasSavedWork) {
    state = "ready";
    label = "Ready when you are";
    title = "Your brain is ready.";
    detail =
      "Drop in anything worth carrying forward. You can organize it later.";
  } else if (readyCount > 0) {
    state = "attention";
    label = "Ready for you";
    title = `${readyCount} next step${readyCount === 1 ? " is" : "s are"} ready.`;
    detail =
      "Prepared from goals you chose. Nothing changes until you review it.";
  } else if (hasActiveJobs && workerOnline) {
    state = "organizing";
    label = "In progress";
    title = "Organizing selected work.";
    detail =
      "Your originals are already safe. Useful preparation will appear here when it is ready.";
  } else if (hasActiveJobs) {
    state = "offline";
    label = "Waiting safely";
    title = "Preparation is waiting.";
    detail =
      "Your originals are safe. Preparation will continue when the worker is available.";
  } else if (hasStaleUnderstanding) {
    state = "refreshing";
    label = "Keeping current";
    title = "Refreshing what changed.";
    detail =
      "Earlier context stays visible as stale until the updated understanding is ready.";
  } else if (preparationEnabled && !workerOnline) {
    state = "offline";
    label = "Preparation offline";
    title = "Your saved work is safe.";
    detail =
      "You can still find and use everything. Stay ahead will resume when preparation is available.";
  } else if (!preparationEnabled) {
    state = "resting";
    label = "Quiet by choice";
    title = "Nothing needs your attention.";
    detail =
      "Everything you saved is ready. Stay ahead is paused until you turn it on.";
  } else {
    state = "caught-up";
    label = "Caught up";
    title = "Your brain is caught up.";
    detail =
      "Your saved work is current. BiBrain will stay quiet until something useful changes.";
  }

  return (
    <section
      className="brain-pulse"
      data-brain-state={state}
      data-ui="living-field"
      aria-labelledby="brain-pulse-title"
      aria-live="polite"
    >
      <div className="brain-pulse-visual" aria-hidden="true">
        <span className="brain-pulse-glow" />
        <svg className="brain-network" viewBox="0 0 220 220">
          <path className="network-path path-one" d="M31 112C48 70 72 47 108 40c37-8 75 10 86 42 13 38-8 79-45 97-42 20-90 3-111-31-9-15-11-25-7-36Z" />
          <path className="network-path path-two" d="M60 164c-1-35 12-75 45-103 26-22 58-27 81-9M38 91c29 1 59 16 82 43 19 22 44 30 69 24" />
          <path className="network-path path-three" d="M71 53c7 27 25 48 50 62 25 15 41 38 43 70M42 135c31-17 68-20 103-10 26 8 43 3 56-13" />
          <circle className="network-node node-one" cx="38" cy="91" r="5" />
          <circle className="network-node node-two" cx="71" cy="53" r="5" />
          <circle className="network-node node-three" cx="145" cy="125" r="6" />
          <circle className="network-node node-four" cx="189" cy="158" r="5" />
          <circle className="network-node node-five" cx="164" cy="185" r="4" />
        </svg>
        <BrainEmblem className="brain-pulse-core" />
      </div>
      <div className="brain-pulse-copy">
        <p className="brain-pulse-label">{label}</p>
        <h2 id="brain-pulse-title">{title}</h2>
        <p>{detail}</p>
        <div className="brain-signal" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
      </div>
    </section>
  );
}

export function BrainQuickFind({
  onFind,
}: {
  onFind: (query: string) => void;
}) {
  const [query, setQuery] = useState("");
  const canFind = query.trim().length > 0;

  return (
    <form
      className="brain-quick-find"
      data-ui="brain-search"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        if (canFind) onFind(query.trim());
      }}
    >
      <label htmlFor="brain-quick-find">Find something in your brain</label>
      <div>
        <input
          id="brain-quick-find"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="A decision, note, person, or project…"
        />
        <button type="submit" disabled={!canFind}>
          Find
        </button>
      </div>
    </form>
  );
}

export function CurrentKnowledge({
  pages,
  gates,
  openSource,
  review,
}: {
  pages: any[];
  gates: Entity[];
  openSource: (id: string) => void;
  review: (
    id: string,
    version: number,
    action: "accept" | "reject" | "undo",
  ) => void;
}) {
  return (
    <div className="knowledge-workspace">
      <div className="section-heading">
        <h2>What BiBrain remembers</h2>
        <span className="muted">Accepted facts first · originals below</span>
      </div>
      {pages.length ? (
        pages.map((page) => (
          <article key={page.entity}>
            <h3>{page.entity}</h3>
            {page.current.map((claim: Entity) => (
              <div key={claim.id} className="claim-row">
                <strong>{claim.data.aspect}</strong>: {String(claim.data.value)}{" "}
                <small>
                  Current ·{" "}
                  {claim.data.authority === "owner_reviewed"
                    ? "reviewed by you"
                    : "literal source evidence"}
                </small>
                <EvidenceList
                  items={claim.data.evidence ?? []}
                  onOpen={openSource}
                />
              </div>
            ))}
            {page.conflicts.length ? (
              <p className="alert">
                Conflicting accepted values need your review.
              </p>
            ) : null}
            {page.uncertain.length ? (
              <p className="muted">
                {page.uncertain.length} proposed change
                {page.uncertain.length === 1 ? "" : "s"} awaits review.
              </p>
            ) : null}
            {page.open_intents.length ? (
              <p>
                Open intention:{" "}
                {page.open_intents.map((i: any) => i.title).join(", ")}
              </p>
            ) : null}
            <details>
              <summary>Earlier versions and sources</summary>
              {page.history.length ? (
                page.history.map((c: Entity) => (
                  <p key={c.id}>
                    {c.data.aspect}: {String(c.data.value)} · {c.data.status}{" "}
                    {c.data.valid_from}–{c.data.valid_to ?? "open"}
                  </p>
                ))
              ) : (
                <p>No retired claims in this view.</p>
              )}
            </details>
          </article>
        ))
      ) : (
        <article className="quiet">
          <h3>No accepted understanding yet.</h3>
          <p>
            Saved originals appear below. Recognized facts wait for your review
            before they become current understanding.
          </p>
        </article>
      )}
      {gates.length ? (
        <section>
          <h2>Decision review and history</h2>
          <p className="muted">
            Offline extraction recognizes one explicit “Entity aspect: value”
            line per note. It does not understand arbitrary prose. Proposed
            changes are not applied until you approve them.
          </p>
          {gates
            .filter((g) => g.data.status === "queued")
            .map((g) => (
              <article key={g.id} data-proposal-id={g.id}>
                <h3>
                  {g.data.entity ??
                    (g.data.type === "intent"
                      ? "Proposed intention"
                      : "New material")}
                </h3>
                <p>
                  {g.data.type === "intent"
                    ? `${g.data.intent?.action ?? "Propose"} intention${g.data.intent?.target_id ? ` ${g.data.intent.target_id}` : ""}`
                    : g.data.field
                      ? `${g.data.field.aspect}: ${String(g.data.field.value)}`
                      : "No factual claim was inferred."}
                </p>
                {g.data.correction ? (
                  <>
                    <h4>Earlier accepted understanding</h4>
                    {g.data.conflicts.length ? (
                      g.data.conflicts.map((c: any) => (
                        <div key={c.id}>
                          <p>
                            {g.data.entity}: {String(c.value)}
                          </p>
                          <EvidenceList
                            items={c.evidence}
                            onOpen={openSource}
                          />
                        </div>
                      ))
                    ) : (
                      <p>No earlier accepted decision.</p>
                    )}
                    <h4>Suggested exact correction — not applied</h4>
                    <p>
                      {g.data.entity}: {String(g.data.field.value)}
                    </p>
                  </>
                ) : (
                  <p className="muted">{g.data.reasons.join(" · ")}</p>
                )}
                <EvidenceList
                  items={g.data.evidence ?? []}
                  onOpen={openSource}
                />
                <div className="actions">
                  {g.data.raw_id ? (
                    <button onClick={() => openSource(g.data.raw_id)}>
                      Read original
                    </button>
                  ) : null}
                  {g.data.type === "intent" && g.data.intent ? (
                    <button onClick={() => review(g.id, g.version, "accept")}>
                      Approve intention
                    </button>
                  ) : g.data.field && g.data.evidence?.length ? (
                    <button onClick={() => review(g.id, g.version, "accept")}>
                      {g.data.correction
                        ? "Approve exact correction"
                        : "Accept reviewed claim"}
                    </button>
                  ) : null}
                  <button onClick={() => review(g.id, g.version, "reject")}>
                    {g.data.correction
                      ? "Keep earlier decision"
                      : "Keep raw only"}
                  </button>
                </div>
              </article>
            ))}
          <details>
            <summary>Reviewed decision history</summary>
            {gates
              .filter((g) => g.data.correction && g.data.status !== "queued")
              .map((g) => (
                <article key={g.id}>
                  <h3>
                    {g.data.entity}: {String(g.data.field.value)}
                  </h3>
                  <p>
                    {g.data.status === "accepted"
                      ? "Approved by you"
                      : g.data.status === "reverted"
                        ? "Undone by you"
                        : "Earlier decision kept"}
                  </p>
                  <EvidenceList
                    items={g.data.evidence ?? []}
                    onOpen={openSource}
                  />
                  {g.data.status === "accepted" ? (
                    <button onClick={() => review(g.id, g.version, "undo")}>
                      Undo correction
                    </button>
                  ) : null}
                  <p className="muted">
                    Undo is refused if later edits or evidence changes make it
                    unsafe.
                  </p>
                </article>
              ))}
          </details>
        </section>
      ) : null}
    </div>
  );
}
export function EvidenceList({
  items,
  onOpen,
}: {
  items: Evidence[];
  onOpen: (id: string) => void;
}) {
  return (
    <div className="evidence">
      {items.map((e, i) => (
        <blockquote key={`${e.source_id}-${i}`}>
          <p>{e.quote}</p>
          <button className="link" onClick={() => onOpen(e.source_id)}>
            See original · version {e.source_version} · passage {e.start}–
            {e.end}
          </button>
        </blockquote>
      ))}
    </div>
  );
}
export function ProposalCard({
  item,
  project,
  onReview,
  onSnooze,
}: {
  item: Entity;
  project: string;
  onReview: (item: Entity) => void;
  onSnooze: (item: Entity) => void;
}) {
  return (
    <article className="featured" data-ui="prepared-review">
      <span className="pill">Ready to review · {project}</span>
      <h2>{item.data.title}</h2>
      <p>{item.data.reason}</p>
      <p className="muted">
        Based on {item.data.evidence.length} sources · Hypothesis · Prepared,
        not applied
      </p>
      <button className="primary" onClick={() => onReview(item)}>
        Review the plan
      </button>
      <button onClick={() => onSnooze(item)}>Later</button>
    </article>
  );
}
