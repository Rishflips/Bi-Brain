import { randomUUID } from "node:crypto";
import type { EvidenceSource } from "../domain/billing-evidence.ts";
import { BillingAuthority } from "../storage/billing-authority.ts";
import { PaddleStore } from "../storage/paddle-store.ts";

/**
 * Bounded reconciliation pass. Events only establish correlation or prompt an
 * adverse refresh; BillingAuthority alone publishes a verified allowance.
 */
export class PaddleBillingWorker {
  readonly id: string;

  constructor(
    private readonly store: PaddleStore,
    private readonly authority: BillingAuthority | null,
    id: string = randomUUID(),
  ) {
    this.id = id;
  }

  async tick(): Promise<boolean> {
    const leased = this.store.leaseEvents(this.id, 10);
    const accounts = new Set<string>();
    for (const event of leased) {
      const applied = this.store.applyLeasedEvent({ ...event, owner: this.id });
      if (applied.account_id) accounts.add(applied.account_id);
    }
    for (const accountId of this.store.dueBindings(4)) accounts.add(accountId);
    for (const accountId of [...accounts].slice(0, 4))
      await this.reconcile(accountId);
    return leased.length > 0 || accounts.size > 0;
  }

  private async reconcile(accountId: string): Promise<void> {
    const row = this.store.binding(accountId);
    if (!row) return;
    if (!this.authority) {
      this.store.setBindingStatus({
        account_id: accountId,
        expected_version: Number(row.version),
        status: "pending_verification",
        retry_ms: 60_000,
      });
      return;
    }
    try {
      const prepared = await this.authority.beginAdmission(accountId);
      if (prepared.state === "prepared")
        this.authority.admitAccount({
          account_id: accountId,
          preflight_id: prepared.preflight_id,
        });
      const decision = await this.authority.reconcile(accountId);
      const current = this.store.binding(accountId);
      if (!current) return;
      this.store.setBindingStatus({
        account_id: accountId,
        expected_version: Number(current.version),
        status: decision.state === "granted" ? "active" : "attention",
        verified: decision.state === "granted",
      });
    } catch {
      const current = this.store.binding(accountId);
      if (!current) return;
      this.store.setBindingStatus({
        account_id: accountId,
        expected_version: Number(current.version),
        // A prior successful check must not keep presenting as current after
        // the provider or authority can no longer verify it.
        status: "attention",
        retry_ms: 60_000,
      });
    }
  }
}

export function createBillingAuthorityForPaddle(input: {
  root: string;
  control: ConstructorParameters<typeof BillingAuthority>[0]["control"];
  evidence: EvidenceSource;
  store: PaddleStore;
  clock: () => Date;
}): BillingAuthority | null {
  try {
    return new BillingAuthority({
      control: input.control,
      root: input.root,
      source: input.evidence,
      correlation: input.store.correlationSource(),
      clock: input.clock,
    });
  } catch {
    // An unenrolled or invalid authority leaves checkout correlation pending;
    // it never degrades to webhook-derived entitlement.
    return null;
  }
}

// The coordinator is provider-neutral; legacy exports preserve historical tests.
export { PaddleBillingWorker as ProviderBillingWorker };
export const createBillingAuthorityForProvider =
  createBillingAuthorityForPaddle;
