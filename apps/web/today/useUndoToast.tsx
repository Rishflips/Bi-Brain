import { friendlyError } from "./BriefCard.tsx";
import { useCallback, useEffect, useRef, useState } from "react";

export function useUndoToast() {
  const [state, setState] = useState<{
    message: string;
    undo?: () => Promise<void>;
  } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback((message: string, undo?: () => Promise<void>) => {
    window.clearTimeout(timer.current);
    setState({ message, undo });
    timer.current = window.setTimeout(() => setState(null), 6000);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const toast = state ? (
    <div className="tv-toast" role="status">
      <span>{state.message}</span>
      {state.undo && (
        <button
          type="button"
          onClick={async () => {
            const undo = state.undo!;
            window.clearTimeout(timer.current);
            setState(null);
            try {
              await undo();
              show("Undone.");
            } catch (e) {
              show(friendlyError(e, "Could not undo."));
            }
          }}
        >
          Undo
        </button>
      )}
    </div>
  ) : null;
  return { toast, show };
}
