import type { Brain } from "../../packages/domain/service.ts";
import type {
  ManagedHandle,
  ManagedRuntime,
} from "../../packages/runtime/managed.ts";
import type { PreparedProvider } from "../../packages/providers/prepared.ts";
import { ManagedSpendingStore, AccountingPersistenceError } from "../../packages/storage/managed-spending.ts";
import { paidTransportsAllowed } from "../../packages/storage/billing-verify.ts";
import { ManagedDispatchAccounting } from "./managed-accounting.ts";
import { TenantOnlyAccounting, type DispatchAccounting } from "./accounting.ts";
import {
  evaluateConfiguredPolicy,
  installDecisionPolicy,
  readActivation,
  type InstalledActivationPolicy,
  type InstalledDecisionPolicy,
} from "../../packages/runtime/managed-activation.ts";
import type { PreparedDecisionProvider } from "../../packages/providers/prepared-decision.ts";
import { validateActivationProfile } from "../../packages/domain/managed-activation.ts";
import { BrainError } from "../../packages/domain/logic.ts";
import { Worker } from "./engine.ts";

/**
 * A closed, production-unavailable provider. It throws on `prepareCall`, so a
 * paid intent yields an explicit unavailable attempt with NO provider call and NO
 * hold — never a lazy `process.env` key read and never an extractive false-success.
 */
const unavailableProvider: PreparedProvider = {
  prepareCall(): never {
    throw new BrainError(
      "PROVIDER_UNAVAILABLE",
      "Connected model processing is not available. Your saved work stays available and extractive.",
      503,
    );
  },
};

export type ManagedWorkerOptions = {
  /**
   * Explicit per-brain provider transport for tests and operator policy. When
   * omitted, the worker uses a fail-closed unavailable provider — never a lazy
   * environment key. This is a TRANSPORT-ONLY seam and can never bypass the frozen
   * activation gate.
   */
  providerFactory?: (brain: Brain) => PreparedProvider;
  /**
   * The frozen installed activation policy, validated and bound at BOOT. When
   * present it is used exactly once and never upgraded per tick; a live profile
   * that drifts from it makes the send guard deny.
   */
  bootstrap?: InstalledActivationPolicy;
  /**
   * The frozen installed DECISION policy, resolved exactly ONCE at boot and never
   * upgraded per tick. Its `worker_id` is the PROCESS boot identity that must match
   * `decision-worker-ready.json`; it is deliberately distinct from each job's
   * per-lease `Worker.id`. When absent there is no decision path and reasoning is
   * byte-unchanged.
   */
  decisionBootstrap?: InstalledDecisionPolicy;
  /**
   * Explicit per-brain DECISION transport for tests and operator policy. When
   * omitted (or no frozen decision bootstrap exists) the decision path is inert; a
   * fake transport can never skip the installed policy or the money coordinator.
   */
  decisionProviderFactory?: (
    brain: Brain,
  ) => Pick<PreparedDecisionProvider, "prepareDecision">;
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
  /** `undefined` = not yet resolved; `null` = resolved to absent. */
  private installedCache?: InstalledActivationPolicy | null;
  /** `undefined` = not yet resolved; `null` = resolved to absent (no decision path). */
  private decisionCache?: InstalledDecisionPolicy | null;

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
    if (!this.paidTransportsAllowed()) return unavailableProvider;
    if (this.options.providerFactory) return this.options.providerFactory(brain);
    return unavailableProvider;
  }

  /**
   * The ACTUAL enrolled billing mode gate. A sandbox billing root must never install a
   * real paid transport or paid coordinator, regardless of ALLOW/keys/profile flags,
   * so no synthetic sandbox payment can ever fund a real model call. Unenrolled/legacy
   * roots keep their existing behavior; the ledger itself still allows injected
   * synthetic funding (that is a test-only composition, not a live transport).
   */
  private paidTransportsAllowed(): boolean {
    return paidTransportsAllowed(
      { db: this.runtime.control.db, path: this.runtime.control.path },
      this.runtime.root,
    );
  }

  /**
   * The frozen installed activation policy for this worker, resolved exactly ONCE
   * and never upgraded per tick. `options.bootstrap` is validated as a full closed
   * profile before use; otherwise the current shared-loader policy is read once at
   * first use. A profile that changes later requires a restart.
   */
  private resolveInstalled(): InstalledActivationPolicy | undefined {
    if (this.installedCache !== undefined)
      return this.installedCache ?? undefined;
    let resolved: InstalledActivationPolicy | undefined;
    if (this.options.bootstrap) {
      const profile = validateActivationProfile(this.options.bootstrap.profile);
      resolved = { root: this.options.bootstrap.root, profile };
    } else {
      resolved = this.installedPolicy();
    }
    this.installedCache = resolved ?? null;
    return resolved;
  }

  /**
   * The frozen installed activation policy for this root, or undefined when the
   * configured policy is not ready. It is the ONLY way a production paid
   * coordinator is ever built; a test fake transport cannot skip it.
   */
  private installedPolicy(): InstalledActivationPolicy | undefined {
    if (!this.paidTransportsAllowed()) return undefined;
    const control = this.runtime.control;
    const optIn = (process.env.BRAIN_MANAGED_ALLOW_PAID ?? "").trim() === "1";
    const configured = evaluateConfiguredPolicy({
      control: { db: control.db, path: control.path },
      root: this.runtime.root,
      now: control.clock(),
      optIn,
    });
    if (!configured.ready) return undefined;
    const profile = readActivation(
      { db: control.db, path: control.path },
      this.runtime.root,
    );
    return profile ? { root: this.runtime.root, profile } : undefined;
  }

  private accountingFor(
    brain: Brain,
    installed: InstalledActivationPolicy | undefined,
  ): DispatchAccounting {
    // Without a ready policy there is no paid coordinator at all: the tenant-bound
    // fail-closed accounting refuses any reserve, so paid intent yields an
    // unavailable attempt with NO hold while capture/extractive work continues.
    if (!installed)
      return new TenantOnlyAccounting(brain.store, brain.clock, brain.tenantId!);
    return new ManagedDispatchAccounting(
      new ManagedSpendingStore(this.runtime.control, brain.clock),
      brain,
      brain.clock,
      installed,
    );
  }

  /**
   * The frozen installed DECISION policy, resolved exactly ONCE and never upgraded
   * per tick. Only an explicit boot `decisionBootstrap` installs it; there is no
   * live hot-reload, so a profile change requires a restart.
   */
  private decisionInstalled(): InstalledDecisionPolicy | undefined {
    if (!this.paidTransportsAllowed()) return undefined;
    if (this.decisionCache !== undefined)
      return this.decisionCache ?? undefined;
    const bootstrap = this.options.decisionBootstrap;
    const resolved = bootstrap
      ? installDecisionPolicy({
          root: bootstrap.root,
          profile: bootstrap.profile,
          worker_id: bootstrap.worker_id,
          optIn: bootstrap.optIn,
        })
      : undefined;
    this.decisionCache = resolved ?? null;
    return resolved;
  }

  private decisionAccountingFor(
    brain: Brain,
    installed: InstalledDecisionPolicy | undefined,
  ): DispatchAccounting | undefined {
    if (!installed) return undefined;
    return new ManagedDispatchAccounting(
      new ManagedSpendingStore(this.runtime.control, brain.clock),
      brain,
      brain.clock,
      installed,
    );
  }

  private decisionProviderFor(
    brain: Brain,
  ): Pick<PreparedDecisionProvider, "prepareDecision"> | undefined {
    if (!this.paidTransportsAllowed()) return undefined;
    return this.options.decisionProviderFactory
      ? this.options.decisionProviderFactory(brain)
      : undefined;
  }

  private async run(): Promise<boolean> {
    const attempted = new Set<string>();
    const installed = this.resolveInstalled();
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
        const accounting = this.accountingFor(handle.brain, installed);
        const installedDecision = this.decisionInstalled();
        const decisionProvider = installedDecision
          ? this.decisionProviderFor(handle.brain)
          : undefined;
        const decisionAccounting =
          installedDecision && decisionProvider
            ? this.decisionAccountingFor(handle.brain, installedDecision)
            : undefined;
        const worker = new Worker(
          handle.brain,
          this.providerFor(handle.brain),
          accounting,
          { decisionAccounting, decisionProvider },
        );
        try {
          // A tick drains every active account once: an account with no queued
          // job must not hide another account that does have work.
          if (await worker.tick()) return true;
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
