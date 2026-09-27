# Release and operations

## Release levels

1. Build pack: documentation and contracts.
2. Runnable local preview: durable capture and truthful extractive mode.
3. Local V1: complete knowledge, preparation, review, and verified agent access.
4. Managed private beta: hosted identity, isolation, operations, metering.
5. Public service: validated reliability, support, and commercial terms.

Never use one level's evidence to claim another.

## Local packaging

Document exact Node/package-manager versions, clean installation, migrations, development, production build, API start, worker start, data directory, and stop/restart.
Provide a reproducible container path where practical, with separate API/worker processes and shared local persistent volume.
Development binds loopback. Supported remote self-hosting requires authenticated HTTPS.
Secrets come from environment or protected local config, never tracked files.

## Operational checks

- Liveness separate from readiness; worker heartbeat visible.
- Failed/retryable/abstained jobs inspectable.
- Database migration version recorded.
- Graceful termination releases or expires leases.
- Provider timeout, cancellation, and rate limits handled.
- Disk-full errors never produce false save success.
- Time zone, daylight-saving boundaries, and host sleep catch-up verified.

## Backup and restore

Use SQLite's supported backup mechanism or a coordinated consistent snapshot. Do not copy a live database while ignoring WAL state.
Include blobs and a versioned manifest. Portable exports exclude credentials; operational backups need secure handling.
Restore to a clean directory; run integrity/foreign-key checks; verify capture, search, jobs, and grants.
Document retention and deletion implications.

## Local V1 gates

- [x] M0–M6 have evidence or explicit narrow limitations.
- [x] Live-provider results are distinct from deterministic tests.
- [x] Two native clients verified or transparently listed as unverified.
- [x] Capture, correction, deletion, export/import, restore work.
- [x] Permission and budget adversarial cases pass.
- [x] UI never pretends external actions happened.
- [x] Demo content cannot be mistaken for user data.
- [x] Keyboard/responsive checks pass.
- [x] Supported environments and limitations documented.
- [ ] License decision completed before public distribution.

## Hosted additions

Identity/recovery, tenant-aware authorization and storage, adversarial isolation tests, HTTPS, managed secrets, per-user budgets, idempotent billing, backups, alerts, incident ownership, retention, and privacy disclosures.
Add one managed connector only after authorization, refresh, revocation, deletion, and incremental sync are tested.

## Launch demonstration

Use arbitrary captured content, source-backed continuation in another agent, new evidence triggering a proposal, accept/undo, and access revocation. Include one failure/recovery example. Label synthetic data. Never publish the owner's private material.

## Verification record — 2026-09-28

See BUILD_STATE.md for commands and evidence. This is a runnable local preview with the local V1 implementation, not a fully verified Local V1 release. Native Codex/second-client sessions, a live provider evaluation, Docker/fresh-machine installation, and human pilot remain unverified. The checked native-client item above records this transparent limitation, not successful client verification. Disk-full and live provider outage drills are also unverified.

