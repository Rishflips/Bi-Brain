import { writeManagedBackup } from "../packages/runtime/managed-recovery.ts";

/**
 * Cold/offline managed backup CLI. The operator must stop the API and worker and
 * pass --offline; this tool cannot prove the filesystem is quiesced. It writes a
 * new bundle directory and never overwrites an existing path.
 *
 * Usage: BRAIN_MANAGED_ROOT=<abs> managed:backup --offline <destination_abs>
 */

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
const offline = args.includes("--offline");
const positional = args.filter((arg) => arg !== "--offline");
if (!offline)
  fail("Pass --offline to confirm the API and worker are stopped.");
if (positional.length !== 1)
  fail("Usage: managed:backup --offline <destination_abs>");
const root = process.env.BRAIN_MANAGED_ROOT;
if (!root)
  fail("Set BRAIN_MANAGED_ROOT to the existing absolute managed root.");

const result = await writeManagedBackup({
  root,
  destination: positional[0]!,
  offline: true,
});
console.log(
  JSON.stringify({
    destination: result.destination,
    accounts: result.accounts,
    files: result.files,
  }),
);
