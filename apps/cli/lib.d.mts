export function parseArgs(argv: string[]): { command: string; flags: Record<string, string | true> };
export function browserCommand(platform: string, url: string): { command: string; args: string[] };
export function keyFilePath(dataDir: string, connectionId: string): string;
export function dataDirFor(root: string, env: Record<string, string | undefined>): string;
