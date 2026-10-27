/**
 * Provider-neutral transport contract, kept under its historical name because
 * the frozen Dodo adapter (`dodo.ts`), `bounded-fetch.ts` and `paddle-store.ts`
 * import it from here. The Paddle client itself was removed in plan 6.
 */

export type PaddleMode = "sandbox" | "live";

export interface PaddleTransport {
  request(input: {
    url: string;
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    timeout_ms: number;
    max_response_bytes: number;
  }): Promise<{ status: number; body: Uint8Array }>;
}
