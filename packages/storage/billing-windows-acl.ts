import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { BrainError } from "../domain/logic.ts";
import { assertNonLinkedPathChain } from "../runtime/managed-operator.ts";

/** Windows DACL enforcement for the billing authority directory and its files. */

const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";
const MAX_OUTPUT = 64 * 1024;

const unavailable = (message: string) =>
  new BrainError("UNAVAILABLE", message, 503);

const inspectScript = String.raw`
$ErrorActionPreference = 'Stop'
$paths = @([Console]::In.ReadToEnd().Split([Environment]::NewLine, [System.StringSplitOptions]::RemoveEmptyEntries))
$views = @($paths | ForEach-Object {
  $container = Test-Path -LiteralPath $_ -PathType Container
  if ($container) { $acl = [System.IO.Directory]::GetAccessControl($_) }
  else { $acl = [System.IO.File]::GetAccessControl($_) }
  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
    [pscustomobject]@{
      sid = $_.IdentityReference.Value
      type = $_.AccessControlType.ToString()
      inherited = $_.IsInherited
      rights = [int64]$_.FileSystemRights
    }
  })
  [pscustomobject]@{ owner = $owner; protected = $acl.AreAccessRulesProtected; rules = $rules }
})
ConvertTo-Json -InputObject $views -Compress -Depth 4
`;

const hardenScript = String.raw`
$ErrorActionPreference = 'Stop'
$paths = @([Console]::In.ReadToEnd().Split([Environment]::NewLine, [System.StringSplitOptions]::RemoveEmptyEntries))
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$owner = $identity.User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$admins = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$paths | ForEach-Object {
  $p = $_
  $container = Test-Path -LiteralPath $p -PathType Container
  if ($container) { $acl = [System.IO.Directory]::GetAccessControl($p) }
  else { $acl = [System.IO.File]::GetAccessControl($p) }
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($owner)
  $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  $prop = [System.Security.AccessControl.PropagationFlags]::None
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  $full = [System.Security.AccessControl.FileSystemRights]::FullControl
  foreach ($sid in @($owner, $system, $admins)) {
    if ($container) {
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, $full, $inherit, $prop, $allow)
    } else {
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, $full, $allow)
    }
    [void]$acl.SetAccessRule($rule)
  }
  if ($container) { [System.IO.Directory]::SetAccessControl($p, $acl) }
  else { [System.IO.File]::SetAccessControl($p, $acl) }
}
`;

interface AclView {
  owner: string;
  protected: boolean;
  rules: Array<{
    sid: string;
    type: string;
    inherited: boolean;
    rights: number;
  }>;
}

function powershell(script: string, paths: string[]): string {
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      input: paths.join("\r\n"),
      windowsHide: true,
      maxBuffer: MAX_OUTPUT,
    },
  );
  if (result.status !== 0 || result.error)
    throw unavailable("Windows could not verify the billing authority ACL.");
  return result.stdout.trim();
}

function protectedPaths(root: string): string[] {
  if (!isAbsolute(root))
    throw unavailable("The billing root must be absolute.");
  const dir = resolve(root, ".protected");
  assertNonLinkedPathChain(dir);
  const paths = [
    dir,
    join(dir, "billing-authority.key"),
    join(dir, "billing-policy.json"),
    join(dir, "billing-enrollment.json"),
  ];
  return paths.filter((path) => {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
        throw unavailable(
          "A protected billing path is not a regular file or directory.",
        );
      return true;
    } catch (error) {
      if (error instanceof BrainError) throw error;
      return false;
    }
  });
}

/** Operator-only hardening; never called by normal server/worker startup. */
export function hardenBillingWindowsAcl(root: string): void {
  if (process.platform !== "win32") return;
  const paths = protectedPaths(root);
  const dir = resolve(root, ".protected");
  if (!paths.includes(dir))
    throw unavailable("The billing authority directory is missing.");
  // Harden the directory first so later files inherit no broad access, then every
  // existing child explicitly so a pre-existing inherited DACL cannot survive.
  powershell(hardenScript, paths);
  verifyBillingWindowsAcl(root);
}

/**
 * Positive Windows proof: protected DACL, no inherited ACEs, and no ACE for any
 * principal other than the current owner, SYSTEM or local Administrators.
 */
export function verifyBillingWindowsAcl(root: string): void {
  if (process.platform !== "win32") return;
  const paths = protectedPaths(root);
  if (!paths.length)
    throw unavailable("The billing authority directory is missing.");
  let views: AclView[];
  try {
    views = JSON.parse(powershell(inspectScript, paths)) as AclView[];
  } catch (error) {
    if (error instanceof BrainError) throw error;
    throw unavailable("Windows returned an unreadable billing authority ACL.");
  }
  if (!Array.isArray(views) || views.length !== paths.length)
    throw unavailable(
      "Windows returned an incomplete billing authority ACL proof.",
    );
  for (const view of views) {
    const allowed = new Set([view.owner, SYSTEM_SID, ADMINISTRATORS_SID]);
    if (
      !view.protected ||
      !view.owner ||
      !Array.isArray(view.rules) ||
      !view.rules.some(
        (rule) =>
          rule.sid === view.owner && rule.type === "Allow" && !rule.inherited,
      ) ||
      view.rules.some(
        (rule) =>
          rule.inherited || rule.type !== "Allow" || !allowed.has(rule.sid),
      )
    )
      throw unavailable(
        "The billing authority ACL is not private to its operator boundary.",
      );
  }
}
