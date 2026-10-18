# Ship audit — 2026-10-07

Status note, 2026-10-18: this is a historical audit. Later merged continuous integration closed its workflow-installation gap, and the uncommitted local release candidate adds the B0 operator lifecycle and default-off B1 billing boundary. Read [RELEASE.md](RELEASE.md) and [BUILD_STATE.md](../BUILD_STATE.md) for current status.

The owner canceled ChatGPT Sites deployment and requested an independent deployment package plus a GitHub checkpoint. The full application remains the SQLite/Git/worker suite, not the separate synthetic Sites probe. This audit repairs confirmed packaging/security issues and records actual evidence. It does not certify a live production server or a completed harness V1.

## Repaired findings

| Priority | Finding | Repair and evidence |
| --- | --- | --- |
| P1 | Container lacked Git, required by the vault on startup/capture/history. | Pinned Node image now installs Git and CA certificates; The supplied CI container smoke requires actual vault history, worker output, capture and persistence after restart. Local Docker evidence remains pending until CI executes. |
| P1 | Only loopback Host/Origin accepted; remote deployment would either fail or encourage disabling guards. Session cookies lacked Secure for HTTPS. | Explicit single HTTPS `BRAIN_PUBLIC_ORIGIN`; exact Host/Origin checks, untrusted forwarded headers, Secure/HttpOnly/Strict cookies and HSTS. Loopback exception is only public liveness. Four new regressions cover authenticated capture, sign-out, CSRF/host/origin denial, scoped filtering/revocation, invalid setup and agent URL rejection. |
| P1 | Independent native adapter could not safely select remote HTTPS and followed redirects with a bearer credential. | Adapter accepts trusted HTTPS or local HTTP origins only, rejects credentials/path/query/remote plaintext, and refuses redirects. Existing grant enforcement is retained. Actual native-client compatibility is still unverified. |
| P1 | Build context included an unrelated nested Site checkout and could inadvertently include future private files. | Docker allowlist excludes data, vaults, secrets, Git and Site checkout. Parent Git and lint explicitly ignore the preserved separate `sites-port/` repository. No owner store or Site source was uploaded. |
| P1 | Dependency scan reported two high advisories. | SDK pinned from 1.30.1 to 1.32.1; source-map-js lock resolution 1.2.1 to 1.2.2. Final npm audit reports zero vulnerabilities. MCP OAuth advisory does not establish exploitability of this stdio adapter; patching removes the reported affected package. |
| P2 | Supervisor forced exit after 300 ms during child shutdown. | Supervisor awaits children with a bounded 15-second forced-stop deadline; Compose uses init and 40-second shutdown grace. Existing real-process restart/worker tests pass. Docker restart/backup smoke is a separate CI gate. |
| P2 | No fresh-checkout Linux/container release gate or operational self-hosting handoff. | Added pinned-action CI, HTTPS Compose/Caddy configuration, isolated container smoke, full-volume backup cautions, acceptance/rollback checklist and deployment-agent prompt. No publishing/deploying action in CI. |
| P2 | Docs described the obsolete five-tool interface and remote hosting as unsupported. | LOCAL_RUN and AGENT_INTEGRATION now document the grant-filtered eight tools and local stdio → HTTPS API topology. Database backup is explicitly distinguished from complete vault/history backup. |

Dependency advisory references: [SDK maintainer advisory](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h), [source-map-js advisory](https://github.com/advisories/GHSA-68fv-2mgg-jv7q). Proxy Host behavior follows [Caddy's official reverse-proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

## Checks actually run

Local runtime: Windows, Node 24.19.0 / npm 11.17.0. Synthetic test stores only; owner database and permissions preserved.

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed; isolated Site checkout excluded |
| `npm test` | 65/65 in 12 files, including four deployment regressions |
| `npm run build` | Passed production frontend build |
| `npm run brain-eval` | 4/4 synthetic offline cases; no provider calls |
| `npm run test:e2e -- --workers=1` | 8/8 Chromium journeys against actual API, worker and persistent test vault |
| `npm audit --audit-level=high` | Zero reported vulnerabilities after patch updates |
| `git diff --check` | Passed |
| Linux fresh checkout, Docker build/smoke and Caddy validation | Template delivered; GitHub credential lacks workflow scope, so installation/execution remain open |

Initial sandboxed tests/eval failed because writes to temporary Git metadata were denied; the same isolated suites passed with approved outside-sandbox execution. A sandboxed advisory request failed DNS resolution; the approved network run succeeded. Initial lint inspected the separate incompatible Sites checkout; its scope is now excluded. A new regression initially exposed the empty pairing-code fallback; startup now rejects it, and all 65 tests passed afterward. These failures were not recorded as successes. Browser-generated screenshots are restored because no UI change is part of this release.

The retained F1–F5 and accepted-intent forgetting regressions cover unsupported/negated fact admission, pack invalidation, validity dates, reviewed actionable intent updates, capture-to-current-truth, and forgotten evidence/derived text. Browser checks include ordinary capture and owner passage review, approved agent intentions, chat import, accept/undo preserving later edits, correction/deletion/reload, and keyboard/responsive controls. Offline evals cover abstention, retirement/conflict, managed forgetting and revoked injected-pack use. These are bounded synthetic proofs, not comprehensive semantic or real-world quality calibration.

## Open release gates

GitHub rejected the first push because the saved PAT cannot create Actions workflows without `workflow` scope. The unpushed commit was revised to retain the workflow as `deploy/github-verify.yml`; privileged workflow installation was not attempted again. Application/handoff checkpoint **`ad35584`** was successfully pushed to official `origin/main` with existing repository authority. Container and fresh-Linux execution remain explicit operator gates until that template runs.

1. **Owner production server:** no server/domain has been supplied or provisioned. DNS/TLS, durable disks, host reboot, firewall, encrypted full-volume recovery, monitoring and operational deletion barriers must be proved on the chosen host. Run SELF_HOSTING's acceptance sequence before owner data.
2. **Harness completion:** filesystem authority remains transitional; broader crash/disk-full/credential-pattern adversarial coverage, non-head revert conflict handling and semantic quality remain open as recorded in BUILD_STATE.
3. **Live provider:** no owner key/model/pricing live evaluation. Paid processing stays off. Ambiguous charges retain reservations and need operator reconciliation; no automated charge reconciliation exists.
4. **Native agents:** SDK/local-wrapper tests are passing, but two actual native-client sessions, automatic injection and enforced client-side pre-action checking remain unverified. No hosted HTTP MCP/OAuth endpoint is supplied.
5. **Human pilot:** broader accessibility/first-use usability evidence remains open.
6. **Sites shutdown — resolved:** after a separate explicit request and final confirmation, the existing Bi Brain Site was permanently deleted on 2026-10-07. The owner Sites list shows “No sites yet,” the connector returns “Sites project not found” for its exact project ID, and the former URL shows “404 Not found / No site here.” No new deployment occurred. Local application data and official GitHub source remain intact. The separate ignored probe checkout is preserved; Sites is excluded from the production path. This verifies Site removal and offline status, not a forensic proof of the platform's internal data erasure.

Licensing, monetization and unrelated features are unchanged. The owner's local licensing memo and separate Site repository are preserved and excluded from this checkpoint. Read [SELF_HOSTING.md](SELF_HOSTING.md) and [DEPLOY_OWN_SERVER.md](../prompts/DEPLOY_OWN_SERVER.md) for the operator handoff.
