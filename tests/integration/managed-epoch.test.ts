import { afterEach, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../../packages/storage/control.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import {
  assertTrustedManagedRoot,
  markerPath,
} from "../../packages/runtime/managed-operator.ts";

/**
 * Root generation binding (Task 2).
 *
 * The control epoch binds to the exact control database and root marker. A
 * marker from another root can never authorize a different database; a missing
 * or mismatched marker denies and is never auto-healed. Owners can always
 * capture, because a managed runtime never requires an epoch.
 */

const ISSUER = "https://synthetic.example.test";
const clock = () => new Date("2026-10-16T09:00:00Z");
const ACK = { offline: true, workers_terminated: true };
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "bibrain-epoch-"));
  roots.push(root);
  return root;
}

function setup(root = tempRoot()) {
  const control = new ControlStore(join(root, "control.sqlite"), clock);
  const spending = new ManagedSpendingStore(control, clock);
  spending.setServicePolicy({ daily_micro_usd: 1000 });
  const recon = new ManagedReconciliationStore(control, root, clock);
  return { root, control, spending, recon };
}

it("initializes the epoch explicitly and is idempotent on repeat", () => {
  const f = setup();
  try {
    const first = f.recon.initEpoch(ACK);
    expect(first.epoch).toBe(1);
    expect(first.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(f.recon.readEpoch()).toEqual(first);
    expect(f.recon.assertRootEpoch()).toEqual(first);
    const marker = JSON.parse(readFileSync(markerPath(f.root), "utf8"));
    expect(marker).toEqual({
      schema: 1,
      epoch: first.epoch,
      nonce: first.nonce,
    });
    // A repeat never rotates or re-mints.
    expect(f.recon.initEpoch(ACK)).toEqual(first);
  } finally {
    f.control.close();
  }
});

it("requires the strict offline acknowledgement to initialize", () => {
  const f = setup();
  try {
    expect(() => f.recon.initEpoch(undefined)).toThrow();
    expect(() => f.recon.initEpoch({ offline: true })).toThrow();
    expect(() =>
      f.recon.initEpoch({ offline: true, workers_terminated: false }),
    ).toThrow();
    expect(f.recon.readEpoch()).toBeUndefined();
    expect(existsSync(markerPath(f.root))).toBe(false);
  } finally {
    f.control.close();
  }
});

it("denies a missing marker for an existing generation instead of re-minting it", () => {
  const f = setup();
  try {
    f.recon.initEpoch(ACK);
    rmSync(markerPath(f.root), { force: true });
    expect(() => f.recon.assertRootEpoch()).toThrow();
    expect(() => f.recon.initEpoch(ACK)).toThrow();
    expect(f.recon.readEpoch()?.epoch).toBe(1);
    expect(existsSync(markerPath(f.root))).toBe(false);
  } finally {
    f.control.close();
  }
});

it("denies a marker whose nonce does not match the control generation", () => {
  const f = setup();
  try {
    f.recon.initEpoch(ACK);
    writeFileSync(
      markerPath(f.root),
      JSON.stringify({ schema: 1, epoch: 1, nonce: "d".repeat(64) }),
    );
    expect(() => f.recon.assertRootEpoch()).toThrow();
  } finally {
    f.control.close();
  }
});

it("refuses a root that passes through a junction", () => {
  const base = tempRoot();
  const real = join(base, "real");
  mkdirSync(real);
  const junction = join(base, "link");
  symlinkSync(real, junction, "junction");
  const control = new ControlStore(join(real, "control.sqlite"), clock);
  try {
    expect(() => assertTrustedManagedRoot(junction)).toThrow();
    expect(
      () => new ManagedReconciliationStore(control, junction, clock),
    ).toThrow();
  } finally {
    control.close();
  }
});

it("binds a marker to its exact root so one root's marker cannot authorize another", () => {
  const a = setup();
  const b = setup();
  try {
    const epochA = a.recon.initEpoch(ACK);
    b.recon.initEpoch(ACK);
    // A's control database must not be reachable under B's root.
    expect(
      () => new ManagedReconciliationStore(a.control, b.root, clock),
    ).toThrow();
    // Copying A's marker into B breaks B's generation.
    writeFileSync(markerPath(b.root), JSON.stringify({
      schema: 1,
      epoch: epochA.epoch,
      nonce: epochA.nonce,
    }));
    expect(() => b.recon.assertRootEpoch()).toThrow();
  } finally {
    a.control.close();
    b.control.close();
  }
});

it("never requires an epoch for capture and denies an uninitialized generation", () => {
  const root = tempRoot();
  const runtime = new ManagedRuntime(root, { clock });
  try {
    const account = runtime.provision(ISSUER, "noepoch-a");
    const recon = new ManagedReconciliationStore(runtime.control, root, clock);
    expect(recon.readEpoch()).toBeUndefined();
    expect(() => recon.assertRootEpoch()).toThrow();
    const h = runtime.acquire(account.id);
    try {
      const saved = h.brain.capture(h.brain.ownerPrincipal(), {
        title: "note",
        body: "SYNTHETIC_CAPTURE_WITHOUT_EPOCH",
      }) as { source_id: string };
      expect(saved.source_id).toBeTruthy();
    } finally {
      h.release();
    }
  } finally {
    runtime.close();
  }
});

it("preserves identity and session rows across a newer-schema refusal", () => {
  const control = new ControlStore(":memory:", clock);
  try {
    const account = control.provision(ISSUER, "guard-a");
    const session = control.issueSession(account.id);
    new ManagedSpendingStore(control, clock);
    control.db.exec(
      "INSERT INTO managed_money_schema(version,applied_at) VALUES(3,'2026-10-16T00:00:00Z')",
    );
    expect(() => new ManagedSpendingStore(control, clock)).toThrow("newer version");
    expect(control.account(account.id)?.id).toBe(account.id);
    expect(control.resolveSession(session.token)?.account_id).toBe(account.id);
  } finally {
    control.close();
  }
});

it("refuses an empty real root and creates no control database", () => {
  const root = tempRoot();
  expect(() => assertTrustedManagedRoot(root)).toThrow();
  expect(existsSync(join(root, "control.sqlite"))).toBe(false);
});

it.skipIf(process.platform === "win32")(
  "keeps the root/control comparison case-exact on POSIX",
  () => {
    const base = tempRoot();
    const upper = join(base, "RootA");
    const lower = join(base, "roota");
    mkdirSync(upper);
    mkdirSync(lower);
    const control = new ControlStore(join(lower, "control.sqlite"), clock);
    try {
      expect(() => assertTrustedManagedRoot(upper, control.path)).toThrow();
    } finally {
      control.close();
    }
  },
);

it("re-validates the root marker on a cached store before a mutation", () => {
  const root = tempRoot();
  const runtime = new ManagedRuntime(root, { clock });
  try {
    const recon = new ManagedReconciliationStore(runtime.control, root, clock);
    recon.initEpoch(ACK);
    mkdirSync(join(root, "outside-marker"));
    renameSync(markerPath(root), join(root, "saved-epoch.json"));
    symlinkSync(join(root, "outside-marker"), markerPath(root), "junction");
    expect(() => recon.assertRootEpoch()).toThrow();
  } finally {
    runtime.close();
  }
});
