import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const image = process.argv[2] ?? "bi-brain:verify";
if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.:@-]*$/.test(image))
  throw new Error("Invalid test image name.");
const volume = `bi-brain-smoke-${randomUUID()}`;
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 60000 }).trim();
const secret = "synthetic-container-smoke-owner-code";
let container;
let base;
async function waitFor(check, message, timeout = 60000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try {
      if (await check()) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(message);
}
function origin() {
  const port = docker(
    "inspect",
    "-f",
    '{{(index (index .NetworkSettings.Ports "4317/tcp") 0).HostPort}}',
    container,
  );
  assert.match(port, /^\d+$/);
  return `http://127.0.0.1:${port}`;
}
try {
  docker("volume", "create", volume);
  container = docker(
    "run",
    "-d",
    "--init",
    "--stop-timeout",
    "40",
    "-p",
    "127.0.0.1::4317",
    "-e",
    `BRAIN_OWNER_SECRET=${secret}`,
    "-v",
    `${volume}:/app/data`,
    image,
  );
  assert.match(container, /^[a-f0-9]{64}$/);
  base = origin();
  // Host policy requires the application's internal port; a TLS proxy preserves
  // the public Host in the remote profile. This isolated local test uses Host explicitly.
  const host = { Host: "127.0.0.1:4317" };
  await waitFor(
    async () =>
      (await fetch(`${base}/api/v1/health/live`, { headers: host })).ok,
    "Container startup failed.",
  );
  assert.equal(
    (await fetch(`${base}/api/v1/today`, { headers: host })).status,
    401,
  );
  const pair = await fetch(`${base}/api/v1/session/pair`, {
    method: "POST",
    headers: { ...host, "Content-Type": "application/json" },
    body: JSON.stringify({ secret }),
  });
  assert.equal(pair.status, 200);
  const { csrf } = await pair.json();
  const headers = {
    ...host,
    "Content-Type": "application/json",
    Cookie: pair.headers.get("set-cookie").split(";")[0],
    "X-Brain-CSRF": csrf,
  };
  const saved = await fetch(`${base}/api/v1/sources`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: "Synthetic container check",
      body: "SYNTHETIC_CONTAINER_RESTART",
      project_id: "inbox",
    }),
  });
  assert.equal(saved.status, 201);
  const { source_id } = await saved.json();
  await waitFor(async () => {
    const response = await fetch(`${base}/api/v1/today`, { headers });
    const today = await response.json();
    return today.briefs?.some(
      (brief) =>
        brief.data.status === "current" &&
        JSON.stringify(brief).includes("SYNTHETIC_CONTAINER_RESTART"),
    );
  }, "Separate worker did not prepare the saved source.");
  assert.match(
    docker(
      "exec",
      container,
      "git",
      "-C",
      "/app/data/brain.vault",
      "log",
      "-1",
      "--format=%H",
    ),
    /^[a-f0-9]{40}$/,
  );
  docker("restart", container);
  base = origin();
  await waitFor(
    async () =>
      (await fetch(`${base}/api/v1/health/live`, { headers: host })).ok,
    "Container restart failed.",
  );
  const retained = await fetch(`${base}/api/v1/sources/${source_id}`, {
    headers,
  });
  assert.equal(retained.status, 200);
  assert.equal((await retained.json()).body, "SYNTHETIC_CONTAINER_RESTART");
  assert.equal(
    (
      await fetch(`${base}/api/v1/sources`, {
        method: "POST",
        headers: { ...headers, Origin: "https://evil.test" },
        body: JSON.stringify({ title: "Denied", body: "Rejected" }),
      })
    ).status,
    403,
  );
  docker("exec", container, "npm", "run", "backup", "--", "smoke.sqlite");
  console.log(
    "Container verified: non-root startup, Git vault, owner auth, worker preparation, persisted session/source after restart, origin denial and SQLite backup.",
  );
} finally {
  if (container) docker("rm", "-f", container);
  docker("volume", "rm", volume);
}
