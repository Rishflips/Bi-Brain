export const scannerVersion = "bounded-secrets-v1";
export function detectSecrets(text: string): string[] {
  const patterns: [string, RegExp][] = [
    ["private_key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
    [
      "api_credential",
      /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/,
    ],
    [
      "assigned_secret",
      /(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret|password)\s*[=:]\s*["']?[A-Za-z0-9_./+\-=]{16,}/i,
    ],
  ];
  return patterns.filter(([, p]) => p.test(text)).map(([name]) => name);
}
