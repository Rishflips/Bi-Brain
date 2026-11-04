export const CONTRACT: string;
export const GENERIC_CLIENTS: string[];
export function genericClient(flag: unknown): "hermes" | "other";
export function parseRecallInput(raw: string): { prompt: string; session: string } | null;
export function parseNoteInput(raw: string): { reply: string; session: string; continued: boolean } | null;
export function recallOutput(text: string): string;
export function noteOutput(): string;
export function pushRecall(opts: { prompt: string; sessionId: string; client: string; dataDir: string; connectionId: string; startedAt: number }): Promise<string>;
export function postNote(opts: { message: string; active: boolean; sessionId: string; client: string; dataDir: string; connectionId: string; startedAt: number }): Promise<void>;
