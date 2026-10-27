import type { Brain } from "../../packages/domain/service.ts";
import { BETTER_SEARCH_STATUS, type BetterSearchStatus, type EmbedProvider } from "../../packages/domain/better-search.ts";
import type { EmbedConfig } from "../../packages/providers/embed.ts";

export type EmbedClient = { config: EmbedConfig; fetcher?: typeof fetch };

/** Writes the startup status. Carries the model key and a label, never the credential or the account id. */
export function publishBetterSearchStatus(
  brain: Brain,
  from: { configured: true; provider: EmbedProvider; model: string; key: string; label: string } | { configured: false; reason: string },
) {
  brain.store.set(BETTER_SEARCH_STATUS, { ...from, updated_at: brain.now() } satisfies BetterSearchStatus);
}

/** Records the latest outcome (and the back-off state) on the published status; does nothing before startup published one. */
export function noteEmbedStatus(brain: Brain, patch: Partial<Pick<BetterSearchStatus, "last_ok_at" | "last_error" | "failures" | "retry_at" | "paused_until">>) {
  try {
    const current = brain.store.setting<BetterSearchStatus | null>(BETTER_SEARCH_STATUS, null);
    if (current) brain.store.set(BETTER_SEARCH_STATUS, { ...current, ...patch });
  } catch {
    /* Status is informational; it must never fail the job. */
  }
}
