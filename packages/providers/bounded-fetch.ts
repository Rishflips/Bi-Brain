import { BrainError } from "../domain/logic.ts";
import type { PaddleTransport } from "./paddle.ts";

const unavailable = () =>
  new BrainError(
    "UNAVAILABLE",
    "Paddle Billing is temporarily unavailable.",
    503,
  );

/**
 * Backend-only transport with redirects disabled and a streaming byte ceiling.
 * No response header or provider body is logged or returned on failure.
 */
export class BoundedFetchTransport implements PaddleTransport {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async request(input: Parameters<PaddleTransport["request"]>[0]) {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const operation = (async () => {
        const response = await this.fetcher(input.url, {
          method: input.method,
          headers: input.headers,
          body: input.body,
          redirect: "error",
          signal: controller.signal,
        });
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > input.max_response_bytes)
          throw unavailable();
        if (!response.body)
          return { status: response.status, body: new Uint8Array() };
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > input.max_response_bytes) {
            await reader.cancel();
            throw unavailable();
          }
          chunks.push(next.value);
        }
        const body = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return { status: response.status, body };
      })();
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(unavailable());
        }, input.timeout_ms);
      });
      return await Promise.race([operation, deadline]);
    } catch (error) {
      if (error instanceof BrainError) throw error;
      throw unavailable();
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
