import type { Entity, Evidence } from "../../packages/contracts/index.ts";

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
          <h2>Review what BiBrain understood</h2>
          <p className="muted">
            BiBrain can suggest one clear memory from a plain “X is Y” sentence
            or an explicit decision. It stays a suggestion until you approve it.
            Ambiguous notes remain saved without invented meaning.
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
                  <p className="muted">
                    {(g.data.reasons ?? [])
                      .map(
                        (reason: string) =>
                          ({
                            ordinary_language_needs_owner_review:
                              "Found in ordinary language · waiting for your review",
                            owner_taught_meaning_needs_review:
                              "Meaning supplied by you · waiting for confirmation",
                            explicit_decision_needs_owner_review:
                              "Explicit decision · waiting for your review",
                            captured_candidate_needs_review:
                              "Exact passage · waiting for your review",
                          })[reason] ?? reason.replaceAll("_", " "),
                      )
                      .join(" · ")}
                  </p>
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
