import { useEffect, useRef, useState } from "react";
import type { Api, BriefItem } from "./types.ts";

type Props = {
  item: BriefItem;
  projectTitle: string;
  api: Api;
  onOpenSource: (id: string) => void;
  onDone: (message: string, undo?: () => Promise<void>) => void;
  onDeferredDismiss: (item: BriefItem, send: () => Promise<unknown>) => void;
  onError: (message: string) => void;
};

const LABEL: Record<BriefItem["kind"], string> = {
  correction: "Changes an earlier decision",
  proposal: "Prepared for your goal",
  failed_job: "Needs a retry",
  agent_memory: "Written down by your agent",
  memory: "Found in something you saved",
  stale: "Still true?",
};
const KEEP: Record<BriefItem["kind"], string> = {
  correction: "Update the decision",
  proposal: "Keep this plan",
  failed_job: "Try again",
  agent_memory: "Keep as true",
  memory: "Keep as true",
  stale: "Still true",
};

export function friendlyError(
  e: unknown,
  fallback = "Your brain is unavailable.",
): string {
  const message = e instanceof Error ? e.message : fallback;
  return /SOURCE_STALE|no longer active/iu.test(message)
    ? "The original changed. This suggestion was removed."
    : message;
}

export function BriefCard({
  item,
  projectTitle,
  api,
  onOpenSource,
  onDone,
  onDeferredDismiss,
  onError,
}: Props) {
  const [fixing, setFixing] = useState(false);
  const [wording, setWording] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const fixBox = useRef<HTMLTextAreaElement>(null);
  const keepBtn = useRef<HTMLButtonElement>(null);
  const wasFixing = useRef(false);
  useEffect(() => {
    if (fixing) fixBox.current?.focus();
    else if (wasFixing.current) keepBtn.current?.focus();
    wasFixing.current = fixing;
  }, [fixing]);
  const t = item.target;
  const gate = t.type === "gate";
  const proposal = t.type === "proposal";
  const canFix =
    (gate && item.aspect !== "status") || proposal || t.type === "claim";

  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      await action();
    } catch (e) {
      onError(friendlyError(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  const keep = (value?: string) =>
    run(async () => {
      if (gate) {
        const r = await api<{ gate_version: number }>(
          `/proposals/gate/${t.id}/review`,
          {
            action: "accept",
            expected_version: t.version,
            ...(value ? { value } : {}),
          },
        );
        onDone(
          value
            ? `Kept in your wording in ${projectTitle}.`
            : `Kept as a fact in ${projectTitle}.`,
          async () => {
            await api(`/proposals/gate/${t.id}/review`, {
              action: "undo",
              expected_version: r.gate_version,
            });
          },
        );
      } else if (proposal) {
        const r = await api<{
          receipt: { id: string };
          goal: { data: { plan_version: number } };
        }>(`/proposals/${t.id}/accept`, {
          expected_version: t.version,
          ...(value ? { edited_artifact: value } : {}),
        });
        onDone("Plan kept. The earlier plan stays in history.", async () => {
          await api(`/receipts/${r.receipt.id}/undo`, {
            expected_version: r.goal.data.plan_version,
          });
        });
      } else if (t.type === "claim") {
        await api(`/claims/${t.id}/confirm`, {});
        onDone("Marked as still true today.");
      } else {
        await api(`/jobs/${t.id}/retry`, {});
        onDone("Trying again. It shows here when it finishes.");
      }
    });

  const startFix = () => {
    if (t.type === "claim") {
      const source = item.evidence[0]?.source_id;
      if (source) onOpenSource(source);
      return;
    }
    if (proposal) {
      void run(async () => {
        const p = await api<{ data: { artifact?: string } }>(
          `/proposals/${t.id}`,
        );
        setWording(p.data.artifact ?? "");
        setFixing(true);
      });
      return;
    }
    setWording(item.title.replace(/^[^:]*:\s*/u, ""));
    setFixing(true);
  };

  const dismiss = () => {
    if (lock.current) return;
    const send = gate
      ? () =>
          api(`/proposals/gate/${t.id}/review`, {
            action: "reject",
            expected_version: t.version,
          })
      : proposal
        ? () =>
            api(`/proposals/${t.id}/dismiss`, { expected_version: t.version })
        : () => api("/brief/dismiss", { signature: item.signature });
    onDeferredDismiss(item, send);
  };

  return (
    <article className="tv-card" aria-labelledby={`tv-t-${item.signature}`}>
      <div className="tv-card-top">
        <span className="tv-tag">{LABEL[item.kind]}</span>
        <span className="tv-faint">{projectTitle}</span>
      </div>
      <h3 id={`tv-t-${item.signature}`}>{item.title}</h3>
      {fixing && (
        <div className="tv-fix">
          <label htmlFor={`tv-fix-${item.signature}`} className="tv-eyebrow">
            Your wording
          </label>
          <textarea
            ref={fixBox}
            id={`tv-fix-${item.signature}`}
            rows={proposal ? 6 : 2}
            value={wording}
            onChange={(e) => setWording(e.target.value)}
          />
        </div>
      )}
      {item.before && (
        <p className="tv-before">
          Replaces: <s>{item.before}</s>
        </p>
      )}
      <p className="tv-why">{item.why}</p>
      {item.evidence.length > 0 && (
        <div className="tv-evidence">
          {item.evidence.map((e) => (
            <button
              type="button"
              key={`${e.source_id}:${e.quote}`}
              className="tv-quote"
              onClick={() => onOpenSource(e.source_id)}
            >
              <q>{e.quote}</q>
              <span className="tv-faint">Open the original</span>
            </button>
          ))}
        </div>
      )}
      <div className="tv-actions">
        {fixing ? (
          <>
            <button
              type="button"
              className="tv-btn tv-primary"
              disabled={busy || !wording.trim()}
              onClick={() => void keep(wording.trim())}
            >
              Save my version
            </button>
            <button
              type="button"
              className="tv-btn tv-ghost"
              onClick={() => setFixing(false)}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              ref={keepBtn}
              type="button"
              className="tv-btn tv-primary"
              disabled={busy}
              onClick={() => void keep()}
            >
              {KEEP[item.kind]}
            </button>
            {canFix && (
              <button
                type="button"
                className="tv-btn"
                disabled={busy}
                onClick={startFix}
              >
                Fix
              </button>
            )}
            {item.kind === "failed_job" && item.source_id && (
              <button
                type="button"
                className="tv-btn"
                onClick={() => onOpenSource(item.source_id!)}
              >
                Open the original
              </button>
            )}
            <button
              type="button"
              className="tv-btn tv-ghost"
              disabled={busy}
              onClick={dismiss}
            >
              Dismiss
            </button>
          </>
        )}
      </div>
    </article>
  );
}
