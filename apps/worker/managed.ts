import type { Brain } from "../../packages/domain/service.ts";
import type {
  ManagedHandle,
  ManagedRuntime,
} from "../../packages/runtime/managed.ts";
import {
  PreparedReasoningProvider,
  type PreparedProvider,
} from "../../packages/providers/prepared.ts";
import { ManagedSpendingStore, AccountingPersistenceError } from "../../packages/storage/managed-spending.ts";
import { ManagedDispatchAccounting } from "./managed-accounting.ts";
import type { DispatchAccounting } from "./accounting.ts";
import { Worker } from "./engine.ts";

export type ManagedWorkerOptions = {
  /**
   * Explicit per-brain provider selection for operator policy and tests. When
   * omitted, every tenant uses the default provider; a tenant with connected
   * processing disabled still runs in clearly labelled extractive mode. There
   * is never an automatic cross-provider fallback.
   */
  providerFactory?: (brain: Brain) => PreparedProvider;
  /**
   * Optional accounting seam for tests and explicit operator policy. When
   * omitted, every tenant gets an account-bound central coordinator over the
   * control database; its default-zero policy denies managed paid work.
   */
  accountingFactory?: (brain: Brain) => DispatchAccounting;
};

/**
 * Runs one queued job for one active managed account per tick.
 *
 * The next account is resolved exclusively from the trusted control database
 * with a keyset cursor over active account ids, wrapping to the lowest id for
 * round-robin fairness. No caller-supplied tenant is accepted, and the worker
 * never opens tenant databases to scan for work.
 *
 * A single tenant/job runs at a time. The runtime handle for the selected
 * account is pinned for the whole asynchronous worker call and released in
 * `finally`, so an account cannot be evicted or swapped underneath an in-flight
 * job and `stop()` can wait for that job before the runtime is closed.
 */
export class ManagedWorker {
  private cursor: string | null = null;
  private stopped = false;
  private inflight: Promise<boolean> | null = null;

  constructor(
    readonly runtime: ManagedRuntime,
    readonly options: ManagedWorkerOptions = {},
  ) {}

  /** Selects the next active account from the control DB by id, wrapping. */
  private selectAccount(): { id: string } | undefined {
    const db = this.runtime.control.db;
    const next = (after: string | null) =>
      (after
        ? db
            .prepare(
              "SELECT id FROM managed_accounts WHERE state='active' AND id>? ORDER BY id LIMIT 1",
            )
            .get(after)
        : db
            .prepare(
              "SELECT id FROM managed_accounts WHERE state='active' ORDER BY id LIMIT 1",
            )
            .get()) as { id: string } | undefined;
    const row = next(this.cursor) ?? next(null);
    if (!row) return undefined;
    this.cursor = row.id;
    return row;
  }

  private providerFor(brain: Brain): PreparedProvider {
    return this.options.providerFactory?.(brain) ?? new PreparedReasoningProvider();
  }

  private async run(): Promise<boolean> {
    const attempted = new Set<string>();
    for (;;) {
      const account = this.selectAccount();
      if (!account || attempted.has(account.id)) return false;
      attempted.add(account.id);
      let handle: ManagedHandle;
      try {
        handle = this.runtime.acquire(account.id);
      } catch {
        // Invalid, suspended or partially provisioned accounts fail closed for
        // that account only. There is no fallback to local data; try the next.
        continue;
      }
      try {
        const accounting =
          this.options.accountingFactory?.(handle.brain) ??
          new ManagedDispatchAccounting(
            new ManagedSpendingStore(this.runtime.control, handle.brain.clock),
            handle.brain,
            handle.brain.clock,
          );
        const worker = new Worker(
          handle.brain,
          this.providerFor(handle.brain),
          accounting,
        );
        try {
          return await worker.tick();
        } catch (error) {
          // A fatal accounting-persistence condition fail-stops managed
          // scheduling; the error propagates once so the operator sees it, and
          // the runtime handle is still released in the enclosing finally.
          if (error instanceof AccountingPersistenceError) this.stopped = true;
          throw error;
        }
      } finally {
        handle.release();
      }
    }
  }

  /**
   * Runs at most one tenant's job. Returns whether a job was processed. A
   * repeated concurrent call returns false rather than dispatching overlapping
   * work, and a stopped worker starts nothing new.
   */
  async tick(): Promise<boolean> {
    if (this.stopped || this.inflight) return false;
    this.inflight = this.run();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  /**
   * Prevents any new job from starting and resolves once the in-flight job (if
   * any) has finished, so the caller may release and close the runtime safely.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    const active = this.inflight;
    if (active) {
      try {
        await active;
      } catch {
        /* The in-flight attempt reported its own failure. */
      }
    }
  }
}
