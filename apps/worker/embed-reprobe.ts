import { embedSetup, shouldReprobe, type EmbedSetup } from "../../packages/providers/embed-env.ts";
import { detectOllamaModel } from "../../packages/providers/ollama-detect.ts";

/** How often the worker looks again for a loopback Ollama while nothing was found (spec 1.1, R1). */
export const REPROBE_MS = 600_000;
export type Reprobe = { stop(): void };

/**
 * An unref'd timer off the tick loop: every 10 minutes, the same bounded loopback probe. It runs only while `shouldReprobe` says so,
 * calls `onFound` once with the detected setup, then stops itself. No log line; nothing from the reply is kept.
 */
export function startReprobe(opts: { env: Record<string, string | undefined>; probe?: typeof detectOllamaModel; intervalMs?: number; onFound: (setup: EmbedSetup & { config: NonNullable<EmbedSetup["config"]> }) => void }): Reprobe {
  const initial: EmbedSetup = { config: null, reason: "", probe: "no_ollama" };
  if (!shouldReprobe(opts.env, initial)) return { stop() {} };
  let busy = false;
  let stopped = false;
  const timer = setInterval(async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const setup = await embedSetup(opts.env, opts.probe ?? detectOllamaModel);
      // A probe already in flight when stop() ran must not act: the worker may be shutting down or its store closed.
      if (!stopped && setup.config && setup.detected) {
        stopped = true;
        clearInterval(timer);
        opts.onFound(setup as EmbedSetup & { config: NonNullable<EmbedSetup["config"]> });
      }
    } catch {
      /* A probe that throws is a probe that found nothing; the next tick looks again. */
    } finally {
      busy = false;
    }
  }, opts.intervalMs ?? REPROBE_MS);
  timer.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
