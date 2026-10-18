import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { auditManagedHistory } from "../../packages/runtime/managed-audit.ts";
import {
  restoreManagedBackup,
  writeManagedBackup,
} from "../../packages/runtime/managed-recovery.ts";
import { enrollBillingAuthorityOffline } from "../../packages/storage/billing-enrollment.ts";
import {
  restoreBillingKeyArchive,
  writeBillingKeyArchive,
} from "../../packages/storage/billing-key-archive.ts";
import { loadBillingKey } from "../../packages/storage/billing-key.ts";
import { loadEnrollmentAnchor } from "../../packages/storage/billing-verify.ts";
import { PaddleStore } from "../../packages/storage/paddle-store.ts";
import { verifyBillingWindowsAcl } from "../../packages/storage/billing-windows-acl.ts";
import { createBillingAdmissionFixture } from "../helpers/billing-admission-fixture.ts";

const roots: string[] = [];
const ACK = { offline: true as const, workers_terminated: true as const };
const BILLING_SCRIPT = resolve("scripts/managed-billing.ts");

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 50,
    });
});

describe("offline billing operator lifecycle", () => {
  it("publishes one verified enrollment from the current audited baseline", () => {
    const fixture = createBillingAdmissionFixture({
      base: join(process.cwd(), "test-results"),
    });
    try {
      const audit = auditManagedHistory({
        control: fixture.control,
        root: fixture.root,
        ...ACK,
        clock: () => new Date("2027-01-31T12:00:00.000Z"),
      });
      expect(audit.ok).toBe(true);
      const enrolled = enrollBillingAuthorityOffline({
        control: fixture.control,
        root: fixture.root,
        key: fixture.key,
        policy: fixture.policy,
        audit_id: audit.audit_id!,
        ...ACK,
        clock: () => new Date("2027-01-31T12:01:00.000Z"),
      });
      expect(enrolled).toMatchObject({
        state: "enrolled",
        mode: "sandbox",
        accounts: 0,
      });
      expect(
        loadEnrollmentAnchor(fixture.control, fixture.root)?.enrollment_digest,
      ).toBe(enrolled.enrollment_digest);
      expect(
        enrollBillingAuthorityOffline({
          control: fixture.control,
          root: fixture.root,
          key: fixture.key,
          policy: fixture.policy,
          audit_id: audit.audit_id!,
          ...ACK,
        }).state,
      ).toBe("already_enrolled");
      if (process.platform === "win32")
        expect(() => verifyBillingWindowsAcl(fixture.root)).not.toThrow();
    } finally {
      fixture.close();
    }
  }, 20_000);

  it("backs up and restores only an authenticated encrypted key envelope", () => {
    const fixture = createBillingAdmissionFixture({
      base: join(process.cwd(), "test-results"),
    });
    const work = mkdtempSync(
      join(process.cwd(), "test-results", "bibrain-key-archive-"),
    );
    roots.push(work);
    const passphrase = join(work, "passphrase.bin");
    const archive = join(work, "billing-key.enc.json");
    const restored = join(work, "restored");
    mkdirSync(restored);
    writeFileSync(
      passphrase,
      Buffer.from("synthetic-long-passphrase-for-tests"),
      {
        mode: 0o600,
      },
    );
    chmodSync(passphrase, 0o600);
    try {
      const backed = writeBillingKeyArchive({
        root: fixture.root,
        destination: archive,
        passphrase_file: passphrase,
        ...ACK,
      });
      const serialized = readFileSync(archive, "utf8");
      expect(serialized).not.toContain(
        Buffer.from(fixture.key).toString("hex"),
      );
      expect(serialized).not.toContain("synthetic-long-passphrase");
      expect(
        restoreBillingKeyArchive({
          root: restored,
          archive,
          passphrase_file: passphrase,
          expected_commitment: backed.key_commitment,
          ...ACK,
        }),
      ).toEqual({ key_commitment: backed.key_commitment });
      expect(loadBillingKey(restored).commitment).toBe(backed.key_commitment);

      const wrong = join(work, "wrong.bin");
      writeFileSync(wrong, Buffer.from("different-long-passphrase-for-tests"), {
        mode: 0o600,
      });
      chmodSync(wrong, 0o600);
      const another = join(work, "another");
      mkdirSync(another);
      expect(() =>
        restoreBillingKeyArchive({
          root: another,
          archive,
          passphrase_file: wrong,
          expected_commitment: backed.key_commitment,
          ...ACK,
        }),
      ).toThrow();
    } finally {
      fixture.close();
    }
  });

  it("rejects an oversized key archive before decryption", () => {
    const work = mkdtempSync(join(tmpdir(), "bibrain-key-input-"));
    roots.push(work);
    const passphrase = join(work, "passphrase.bin");
    writeFileSync(
      passphrase,
      Buffer.from("synthetic-long-passphrase-for-tests"),
      { mode: 0o600 },
    );
    chmodSync(passphrase, 0o600);
    const oversized = join(work, "oversized.enc.json");
    writeFileSync(oversized, Buffer.alloc(4097, 0x61));
    expect(() =>
      restoreBillingKeyArchive({
        root: join(work, "oversized-restore"),
        archive: oversized,
        passphrase_file: passphrase,
        expected_commitment: "a".repeat(64),
        ...ACK,
      }),
    ).toThrow(/bounded regular file/);
  });

  it("rejects a hard-linked key archive before decryption", (ctx) => {
    const work = mkdtempSync(join(tmpdir(), "bibrain-key-link-"));
    roots.push(work);
    const passphrase = join(work, "passphrase.bin");
    writeFileSync(
      passphrase,
      Buffer.from("synthetic-long-passphrase-for-tests"),
      { mode: 0o600 },
    );
    chmodSync(passphrase, 0o600);
    const original = join(work, "original.enc.json");
    const linked = join(work, "linked.enc.json");
    writeFileSync(original, "{}");
    try {
      linkSync(original, linked);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
        ctx.skip("Windows link privilege is unavailable on this host.");
        return;
      }
      throw error;
    }
    expect(() =>
      restoreBillingKeyArchive({
        root: join(work, "linked-restore"),
        archive: linked,
        passphrase_file: passphrase,
        expected_commitment: "a".repeat(64),
        ...ACK,
      }),
    ).toThrow(/regular single-link file/);
  });

  it("binds a cold backup to key metadata without exporting the authority key", async () => {
    const fixture = createBillingAdmissionFixture({
      base: join(process.cwd(), "test-results"),
    });
    const work = mkdtempSync(
      join(process.cwd(), "test-results", "bibrain-key-manifest-"),
    );
    roots.push(work);
    const bundle = join(work, "bundle");
    const restored = join(work, "restored");
    try {
      const paddle = new PaddleStore(join(fixture.root, "paddle.sqlite"));
      const intent = paddle.createIntent({
        account_id: fixture.account_id,
        mode: "sandbox",
        cadence: "monthly",
        product_ref: "SYNTHETIC-product",
        price_ref: "SYNTHETIC-price",
      });
      paddle.close();
      await writeManagedBackup({
        root: fixture.root,
        destination: bundle,
        offline: true,
      });
      const manifest = JSON.parse(
        readFileSync(join(bundle, "manifest.json"), "utf8"),
      );
      expect(manifest.paddle_store).toBe("paddle.sqlite");
      expect(manifest.billing_authority).toEqual({
        key_path: ".protected/billing-authority.key",
        key_commitment: loadBillingKey(fixture.root).commitment,
        key_size: 32,
        included: false,
        restore_requires_offline_key_and_reenrollment: true,
      });
      expect(
        manifest.files.some((file: { path: string }) =>
          file.path.includes("billing-authority.key"),
        ),
      ).toBe(false);

      await restoreManagedBackup({
        bundle,
        destination: restored,
        currentRoot: fixture.root,
        offline: true,
      });
      expect(() => loadBillingKey(restored)).toThrow();
      const restoredPaddle = new PaddleStore(join(restored, "paddle.sqlite"));
      try {
        expect(restoredPaddle.intent(intent.intent_id)).toMatchObject({
          state: "expired",
        });
      } finally {
        restoredPaddle.close();
      }
    } finally {
      fixture.close();
    }
  }, 30_000);

  it("runs enrollment through the closed offline CLI without printing key material", () => {
    const fixture = createBillingAdmissionFixture({
      base: join(process.cwd(), "test-results"),
    });
    const work = mkdtempSync(
      join(process.cwd(), "test-results", "bibrain-billing-cli-"),
    );
    roots.push(work);
    const audit = auditManagedHistory({
      control: fixture.control,
      root: fixture.root,
      ...ACK,
    });
    const policyPath = join(work, "policy.json");
    const keyPath = join(work, "key.bin");
    writeFileSync(policyPath, JSON.stringify(fixture.policy));
    writeFileSync(keyPath, fixture.key);
    fixture.runtime.close();
    const run = (args: string[]) =>
      spawnSync(
        process.execPath,
        ["--import", "tsx", BILLING_SCRIPT, ...args],
        {
          cwd: process.cwd(),
          env: { ...process.env, BRAIN_MANAGED_ROOT: fixture.root },
          encoding: "utf8",
          timeout: 30_000,
        },
      );
    try {
      expect(
        run(["enroll", audit.audit_id!, policyPath, keyPath, "--offline"])
          .status,
      ).not.toBe(0);
      const enrolled = run([
        "enroll",
        audit.audit_id!,
        policyPath,
        keyPath,
        "--offline",
        "--workers-terminated",
      ]);
      expect(enrolled.status).toBe(0);
      expect(JSON.parse(enrolled.stdout)).toMatchObject({
        command: "enroll",
        state: "enrolled",
        mode: "sandbox",
      });
      expect(`${enrolled.stdout}${enrolled.stderr}`).not.toContain(
        Buffer.from(fixture.key).toString("hex"),
      );
    } finally {
      fixture.close();
    }
  }, 40_000);
});
