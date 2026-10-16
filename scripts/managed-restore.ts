import { restoreManagedBackup } from "../packages/runtime/managed-recovery.ts";

/**
 * Cold/offline managed restore CLI. The operator must stop the API and worker and
 * pass --offline; this tool cannot prove the filesystem is quiesced. It writes a
 * new, absent destination root, replays the CURRENT root's deletions, and never
 * overwrites an existing path or resurrects restored credentials.
 *
 * Usage: managed:restore --offline <bundle_abs> <new_destination_abs> --current-root <current_abs>
 */

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
let offline = false;
let currentRoot: string | undefined;
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--offline") offline = true;
  else if (arg === "--current-root") currentRoot = args[++i];
  else if (arg && arg.startsWith("--")) fail(`Unknown flag ${arg}.`);
  else if (arg) positional.push(arg);
}

if (!offline)
  fail("Pass --offline to confirm the API and worker are stopped.");
if (positional.length !== 2)
  fail(
    "Usage: managed:restore --offline <bundle_abs> <new_destination_abs> --current-root <current_abs>",
  );
if (!currentRoot) fail("Pass --current-root <current_abs>.");

const result = await restoreManagedBackup({
  bundle: positional[0]!,
  destination: positional[1]!,
  currentRoot,
  offline: true,
});
console.log(
  JSON.stringify({
    destination: result.destination,
    accounts: result.accounts,
    replayed: result.replayed,
  }),
);
