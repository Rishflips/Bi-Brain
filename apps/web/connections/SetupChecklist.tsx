import { setupChecklist } from "./setup-checklist.ts";
import type { Grant } from "./types.ts";

/** What is left to do after Add, with the agent's own instructions behind Details. Ticks come from recorded signals only. */
export function SetupChecklist({ grant, hint }: { grant: Grant; hint: string }) {
  const items = setupChecklist(grant);
  if (!items) return null;
  return (
    <div className="cx-setup">
      <ol className="cx-steps" aria-label={`Getting ${grant.client_name} started`}>
        {items.map((item) => (
          <li key={item.id} className="cx-step" data-done={item.done ? "true" : "false"}>
            <span className="cx-tick" aria-hidden="true">
              {item.done ? "✓" : ""}
            </span>
            <span>
              {item.label}
              <span className="tv-sr"> {item.done ? "(done)" : "(not yet)"}</span>
            </span>
          </li>
        ))}
      </ol>
      <details className="cx-details">
        <summary>Details</summary>
        <p className="tv-faint">{hint}</p>
      </details>
    </div>
  );
}
