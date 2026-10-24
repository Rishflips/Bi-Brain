import { useState } from "react";
import { friendlyError } from "./BriefCard.tsx";
import type { Api } from "./types.ts";

/** Tells the server to watch or stop watching a project. Throws the server's own message on failure. */
export function setWatched(api: Api, projectId: string, watched: boolean) {
  return api(`/projects/${encodeURIComponent(projectId)}/watch`, { watched }, "PUT");
}

type Props = {
  title: string;
  watched: boolean;
  /** Saves the choice and refreshes whatever depends on it. A rejection is shown, and the switch flips back. */
  onSet: (watched: boolean) => Promise<void>;
  onError: (message: string) => void;
};

/**
 * One switch for "should this project show up on Today". It flips at once and
 * returns if the server refuses. The Inbox never gets one: it is always watched.
 */
export function WatchSwitch({ title, watched, onSet, onError }: Props) {
  const [pending, setPending] = useState<boolean | null>(null);
  const on = pending ?? watched;
  return (
    <label className="tv-watch">
      <input
        type="checkbox"
        role="switch"
        aria-label={`Watch ${title}`}
        checked={on}
        disabled={pending !== null}
        onChange={async (e) => {
          const next = e.target.checked;
          setPending(next);
          try {
            await onSet(next);
          } catch (error) {
            onError(friendlyError(error, "Could not change this."));
          } finally {
            setPending(null);
          }
        }}
      />
      <span className="tv-faint">{on ? "Watching" : "Quiet: not on Today"}</span>
    </label>
  );
}
