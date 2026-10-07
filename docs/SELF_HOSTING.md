# Deploy your own Bi Brain

Deploy the full application from [Rishflips/Bi-Brain](https://github.com/Rishflips/Bi-Brain). ChatGPT Sites is no longer a deployment target. The separate `sites-port/` compatibility probe is excluded from this repository and container context.

This package is for **one owner on one always-on Linux host with persistent disk**. API and worker share SQLite and a real Git-backed vault. Do not put the backend on ephemeral serverless functions, mount it on multiple hosts, or run multiple application replicas. A frontend-only upload cannot run this product. See [BUILD_STATE](../BUILD_STATE.md) and the [ship audit](SHIP_AUDIT_2026-10-07.md) for verified and open gates.

## Install and pair

Use Docker Engine with Compose v2, a domain whose DNS points to the server, and inbound TCP 80/443. Keep port 4317 private. The compose file publishes only the HTTPS proxy. Docker administrator access permits reading all application data; restrict it to the owner/operator. Use encrypted host disks and encrypted off-host backups. No managed identity, password recovery or multi-user isolation is supplied.

Run these commands on your Linux server from a fresh checkout. Set the hostname you own in the private deployment environment file; it must be a hostname only, without a scheme or path. Do not upload existing owner data until the synthetic acceptance checks pass.

```sh
git clone https://github.com/Rishflips/Bi-Brain.git
cd Bi-Brain
git rev-parse HEAD
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
# Edit deploy/.env: BRAIN_DOMAIN=your.actual.hostname
docker compose --env-file deploy/.env -f deploy/compose.yaml config --quiet
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build --wait
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
```

The image pins Node 24.19.0 and includes Git and CA certificates. It runs as the nonroot `node` user. The app generates a random 256-bit installation code in its persistent volume, never in logs. Retrieve it only through your private server terminal:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml exec brain cat /app/data/owner-secret
```

Open `https://your.actual.hostname` and pair with that code. Do not send the code to a chat, commit it, pass it in URLs, or include it in verification screenshots. Treat it as the owner's sign-in credential. Sessions expire after seven days and use Secure, HttpOnly, SameSite Strict cookies with CSRF checks. The API accepts only the configured HTTPS Host/Origin; forwarded headers do not grant access. Native clients without Origin still require a scoped bearer grant.

Caddy obtains and renews certificates using persistent `caddy-data`/`caddy-config` volumes. Preserve the public Host when substituting another trusted TLS proxy. Set `BRAIN_PUBLIC_ORIGIN` to the exact HTTPS origin; keep the app listener inaccessible outside the proxy. Do not serve the remote app over plaintext or disable TLS validation. Native `npm start` binds loopback; `BRAIN_CONTAINER=1` is the explicit container bind setting.

## Acceptance before owner data

The build agent's saved GitHub credential lacks `workflow` scope, so the pipeline is delivered as `deploy/github-verify.yml` instead of installed Actions. An authorized repository operator should copy it to `.github/workflows/verify.yml`, commit/push with workflow permission, and record the result. It never deploys. Until then, Docker/Linux runtime checks are unverified. On a staging Docker host you can also run `docker build -t bi-brain:verify .` followed by `node scripts/container-smoke.mjs bi-brain:verify` (requires local Node 24.19); it creates/removes only uniquely named synthetic containers and volumes.

Record the exact Git commit, image ID, host/runtime versions and evidence in your deployment report. The supplied CI pipeline must be installed and executed to verify synthetic container behavior; it cannot prove your DNS, TLS, disk or firewall configuration.

1. Confirm HTTPS with a trusted certificate and HTTP redirect. In a signed-out browser, Today and readiness return 401; liveness discloses only status. Check session cookies are Secure/HttpOnly. A wrong Origin or Host must fail.
2. Capture clearly labeled synthetic text. Verify evidence, worker preparation, correction, current claim review, current-truth retrieval and intent approval. Inspect worker heartbeat and failures in the app. Paid processing remains off.
3. Restart the container, then the host. Verify source, reviewed claims and Git history survive; check the separate worker resumes. Verify an expired lease recovers without duplicate publication using the regression suite/isolated staging environment.
4. Create a project-scoped expiring grant in Connections. Retrieve the synthetic knowledge through your actual native client. Private and other-project material must stay hidden. Revoke the grant and verify immediate denial in a fresh operation. Record client name/version. SDK test success is not native-client certification.
5. Verify a full-volume backup/restore on a separate isolated installation, including vault history, quarantine and deletion barriers. Exercise forgetting and its managed proof. Previously transmitted copies and unmanaged backups cannot be recalled.
6. Only after these checks migrate owner data through a private consistent backup or reviewed import. Review open release gates in BUILD_STATE; do not label offline extractive mode as live reasoning.

## Native agents and optional models

The adapter runs **locally in your native client over stdio** and calls this server's HTTPS API. Install this repository and `npm ci` on the client machine, then use the absolute-path example in [LOCAL_RUN](LOCAL_RUN.md) with `BRAIN_API_URL=https://your.actual.hostname`. Store `BRAIN_AGENT_TOKEN` in private client configuration. The eight-tool contract remains grant-filtered. This package does not implement a public HTTP MCP/OAuth server or automatic native-session injection.

Paid model processing is disabled by default. If explicitly enabled later, pass the backend-only variables listed in `.env.example` through a protected Compose override/environment file outside Git; apply them to the `brain` service. Domain interpolation alone does not pass every variable from an env file into the container. Never pass provider secrets to Caddy or frontend assets. Configure current model/prices, sharing permission and budgets in the app before dispatch. Live model quality/cost reconciliation remains a separate gate.

## Backup, restore and rollback

`npm run backup` uses SQLite's online backup API, including WAL, but **does not back up filesystem Git history or quarantined originals**. It is an additional database snapshot, not a full operational recovery copy. To preserve the complete managed store, stop the app before archiving its whole data volume. Keep the archive encrypted off-host with a manifest containing commit, timestamp, image ID, checksums and deletion checkpoint. Set a retention policy; older backups may contain forgotten content.

Example full-volume snapshot on Linux (local file is sensitive):

```sh
umask 077
mkdir -p private-backups
stamp=$(date -u +%Y%m%dT%H%M%SZ)
docker compose --env-file deploy/.env -f deploy/compose.yaml stop brain
docker compose --env-file deploy/.env -f deploy/compose.yaml run --rm --no-deps -T brain tar -C /app/data -czf - . > "private-backups/brain-$stamp.tar.gz"
# Check command success and archive contents before resuming; encrypt off-host.
docker compose --env-file deploy/.env -f deploy/compose.yaml start brain
```

Restore into a **new, empty, isolated volume**, never over a running installation. Retain the current store/tombstones until restored deletion barriers are verified. The archive includes pairing code, sessions and grants: keep it private, do not expose a restored clone with active credentials, and revoke/re-pair before release. Prefer the supported database restore command to validate integrity/foreign keys, sanitize dependent data with current tombstones and revoke restored sessions/grants. Stop all processes before switching `BRAIN_DB`; review all deletions since the backup, including copies no longer available. A plain historical volume restore can resurrect forgotten content and is not an acceptable shortcut. Test filesystem history and quarantine recovery separately; database restore alone cannot certify them.

For upgrades, take a complete consistent backup, record the working commit/image, read migration notes, and first verify the new image against an isolated copy. Git checkout/rebuild rolls back **application code**, not data. Do not run an older schema-incompatible binary against upgraded data or restore old data without current deletion barriers. Literal vault `git revert` is guarded and is distinct from application rollback.

Monitor disk space, container restart count, HTTPS renewal, worker heartbeat/queue failures and backup restore age. Liveness alone is not worker readiness. Logs contain route/status/timing metadata, not knowledge or secrets. Compose restarts failed processes but does not provide paging, external monitoring, disk-full proof, or disaster recovery by itself. Never use `docker compose down -v` on retained owner data.
