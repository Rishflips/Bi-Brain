import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "brain-decision-consent-primitives-parent-"));
  const runtime = new ManagedRuntime(root);
  const account = runtime.provision("https://issuer.synthetic.test", "synthetic-decision-consent");
  const handle = runtime.acquire(account.id);
  return { runtime, handle, brain: handle.brain, owner: handle.brain.ownerPrincipal(),
    close() { handle.release(); runtime.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };
}

it("existing managed accounts default to no decision-provider consent and cannot enable it without capability", () => {
  const f = fixture();
  try {
    const p = f.brain.prefs(f.owner);
    expect(p).toMatchObject({ decision_provider_enabled: false });
    expect(() => f.brain.prefs(f.owner, { ...p, decision_provider_enabled: true })).toThrow();
    expect(f.brain.prefs(f.owner)).toMatchObject({ decision_provider_enabled: false });
  } finally { f.close(); }
});

it("an unrelated preference save preserves both raw consent choices during provider unavailability", () => {
  const f = fixture();
  try {
    const p = f.brain.prefs(f.owner);
    // Historical choice setup for a NEGATIVE unavailable-state test, not a
    // substitute for proving valid paid admission or permission to send.
    f.brain.store.set("preferences", { ...p, provider_enabled: true, decision_provider_enabled: true });
    const { provider_enabled: _master, decision_provider_enabled: _decision, ...rest } = f.brain.store.setting<Record<string, unknown>>("preferences", {});
    f.brain.prefs(f.owner, { ...rest, daily_cap_micro_usd: 17 });
    expect(f.brain.store.setting("preferences", {})).toMatchObject({ provider_enabled: true, decision_provider_enabled: true, daily_cap_micro_usd: 17 });
  } finally { f.close(); }
});

it("a stored decision consent remains withdrawable when no decision worker or profile exists", () => {
  const f = fixture();
  try {
    const p = f.brain.prefs(f.owner);
    f.brain.store.set("preferences", { ...p, provider_enabled: true, decision_provider_enabled: true });
    const { provider_enabled: _master, ...rest } = f.brain.store.setting<Record<string, unknown>>("preferences", {});
    f.brain.prefs(f.owner, { ...rest, decision_provider_enabled: false });
    expect(f.brain.store.setting("preferences", {})).toMatchObject({ provider_enabled: true, decision_provider_enabled: false });
  } finally { f.close(); }
});

it("withdrawing master consent stops the master without silently rewriting the separate stored decision choice", () => {
  const f = fixture();
  try {
    const p = f.brain.prefs(f.owner);
    f.brain.store.set("preferences", { ...p, provider_enabled: true, decision_provider_enabled: true });
    const { decision_provider_enabled: _decision, ...rest } = f.brain.store.setting<Record<string, unknown>>("preferences", {});
    f.brain.prefs(f.owner, { ...rest, provider_enabled: false });
    expect(f.brain.store.setting("preferences", {})).toMatchObject({ provider_enabled: false, decision_provider_enabled: true });
  } finally { f.close(); }
});

it("an optional undefined decision-consent field is omission, not an implicit withdrawal", () => {
  const f = fixture();
  try {
    const p = f.brain.prefs(f.owner);
    f.brain.store.set("preferences", { ...p, provider_enabled: true, decision_provider_enabled: true });
    const { provider_enabled: _master, decision_provider_enabled: _decision, ...rest } = f.brain.store.setting<Record<string, unknown>>("preferences", {});
    f.brain.prefs(f.owner, { ...rest, decision_provider_enabled: undefined });
    expect(f.brain.store.setting("preferences", {})).toMatchObject({ provider_enabled: true, decision_provider_enabled: true });
  } finally { f.close(); }
});
