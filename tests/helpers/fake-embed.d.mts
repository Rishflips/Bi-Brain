export const FAKE_EMBED_DIM: number;
export const FAKE_EMBED_MODEL: string;
export const LEXICON: string[][];
export function fakeTokens(text: string): string[];
export function fakeEmbed(text: string): number[];
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number;
export function ollamaBody(texts: string[]): { model: string; embeddings: number[][]; prompt_eval_count: number };
export function cloudflareBody(texts: string[]): { success: true; errors: never[]; messages: never[]; result: { shape: [number, number]; data: number[][] } };
export function fakeEmbedFetcher(options?: { shape?: "ollama" | "cloudflare"; delayMs?: number; status?: number; reject?: (texts: string[]) => boolean; before?: (texts: string[]) => void | Promise<void> }): {
  fetcher: typeof fetch;
  calls: { n: number; bodies: unknown[]; texts: string[][]; headers: Record<string, string>[] };
};
