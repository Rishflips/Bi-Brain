import type { ControlStore } from "../storage/control.ts";
import {
  ManagedSpendingStore,
  isManagedControlPaused,
} from "../storage/managed-spending.ts";
import { BrainError } from "../domain/logic.ts";
import { accountingDay, safeAdd } from "../domain/spend.ts";
import { utcDay, type ManagedSpendView } from "../domain/managed-spend.ts";

/**
 * Pure, own-account view of the central managed money ledger, read only through
 * the trusted control database and bound to one server-known account id.
 *
 * It never reads the tenant projection and never exposes the singleton service
 * cap or any service-wide committed total: the shared-service dimension is
 * reduced to a boolean. The account is re-checked active before the first read
 * and again before the value is returned, so a just-suspended account cannot be
 * served a cached figure. A check that cannot complete fails closed (throws)
 * rather than falling back to a zero-as-free view.
 */
export function managedMoneyView(
  control: ControlStore,
  accountId: string,
  clock: () => Date = () => new Date(),
): ManagedSpendView {
  const assertActive = () => {
    const account = control.account(accountId);
    if (!account || account.state !== "active")
      throw new BrainError("UNAUTHORIZED", "Managed account unavailable.", 401);
  };
  assertActive();
  const store = new ManagedSpendingStore(control, clock);
  const status = store.accountStatus(accountId);
  const now = clock();
  const paused = isManagedControlPaused(control);
  const tz = status.policy?.accounting_tz ?? null;
  const budgetDay = tz ? accountingDay(now, tz) : utcDay(now);
  const settled = store.ownDaySettledMicroUsd(accountId, budgetDay);
  const unresolved = store.ownUnresolvedMicroUsd(accountId);
  const committed = safeAdd(settled, unresolved);
  const perJobLimit = status.policy?.per_job_micro_usd ?? 0;
  const dailyLimit = status.policy?.user_daily_micro_usd ?? 0;
  const serviceConfigured = !!status.service && status.service.daily_micro_usd > 0;
  // Capacity, not paid activation: the shared service has a positive policy AND
  // headroom today. `available` remains hard-false regardless.
  const serviceAvailable =
    serviceConfigured &&
    !status.blocked &&
    !paused &&
    status.committed.service_day_micro_usd < (status.service?.daily_micro_usd ?? 0);
  const period = status.period;
  const configured =
    !!status.policy &&
    !!period &&
    serviceConfigured &&
    perJobLimit > 0 &&
    dailyLimit > 0 &&
    period.allowance_micro_usd > 0;
  const periodLimit = period?.allowance_micro_usd ?? 0;
  const periodCommitted = status.committed.account_period_micro_usd;
  assertActive();
  return {
    available: false,
    configured,
    paused,
    blocked: status.blocked || paused,
    blocked_reason: status.blocked_reason,
    account_id: accountId,
    time_zone: tz,
    budget_day: budgetDay,
    settled_micro_usd: settled,
    unresolved_micro_usd: unresolved,
    committed_micro_usd: committed,
    per_job_limit_micro_usd: perJobLimit,
    daily_limit_micro_usd: dailyLimit,
    remaining_micro_usd: Math.max(0, dailyLimit - Math.min(dailyLimit, committed)),
    service_available: serviceAvailable,
    allowance: {
      window_start: period?.starts_at ?? null,
      window_end: period?.ends_at ?? null,
      limit_micro_usd: periodLimit,
      committed_micro_usd: periodCommitted,
      remaining_micro_usd: Math.max(
        0,
        periodLimit - Math.min(periodLimit, periodCommitted),
      ),
    },
  };
}
