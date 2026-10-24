# Independent deployment agent handoff

Deploy the full single-owner Bi Brain application from https://github.com/Rishflips/Bi-Brain. Do not create, update, publish or migrate anything through ChatGPT Sites. Read AGENTS.md, BUILD_STATE.md, docs/SELF_HOSTING.md and docs/history/SHIP_AUDIT_2026-10-07.md before acting.

Use an owner-selected always-on Linux host with persistent encrypted disk and a hostname controlled by the owner. No server has been provisioned by the build agent. Ask only for missing host/domain access; do not select a paid plan or incur spending without authorization. This repository has SQLite, filesystem Git history, a durable worker and a stdio native-client adapter; ephemeral/serverless/frontend-only deployment is incompatible. Do not change licensing, monetization or implement multi-tenant hosting as part of this handoff.

Select the latest verified main commit, install deploy/github-verify.yml as .github/workflows/verify.yml with an authorized GitHub credential, then inspect CI results, and deploy deploy/compose.yaml with its private domain file. Preserve existing owner stores and access rules. Keep API port 4317 private behind HTTPS. Do not expose installation codes, provider keys, agent tokens or source text in logs/screenshots/reports. Provider processing stays disabled unless separately authorized and configured.

Before owner data, complete the synthetic acceptance sequence in SELF_HOSTING: trusted TLS and sign-out denial; capture/evidence/correction/current truth; intent approval; separate-worker preparation and heartbeat; container and host restart persistence; private/cross-project grant filtering and revocation in the actual native client; full-volume recovery and deletion barriers on an isolated restore. Record actual evidence and exact versions/commit. Distinguish offline preview, live model, native-client and operational results. Do not simulate a blocked gate.

Report the live URL, deployed commit/image, verified checks, backup/rollback procedure and remaining gaps. Update BUILD_STATE with real evidence. A reachable home page or green build alone is not a verified production deployment.
