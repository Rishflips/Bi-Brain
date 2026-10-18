import { describe, expect, it } from "vitest";
import { BrainError } from "../../packages/domain/logic.ts";
import { BoundedFetchTransport } from "../../packages/providers/bounded-fetch.ts";

const request = {
  url: "https://sandbox-api.paddle.com/transactions",
  method: "GET" as const,
  headers: {},
  timeout_ms: 100,
  max_response_bytes: 4,
};

describe("bounded provider transport", () => {
  it("stops streamed responses at the byte ceiling", async () => {
    const transport = new BoundedFetchTransport(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(Uint8Array.from([1, 2, 3]));
              controller.enqueue(Uint8Array.from([4, 5, 6]));
              controller.close();
            },
          }),
        ),
    );
    await expect(transport.request(request)).rejects.toBeInstanceOf(BrainError);
  });

  it("turns network details into one static unavailable error", async () => {
    const transport = new BoundedFetchTransport(async () => {
      throw new Error("sensitive upstream diagnostic");
    });
    await expect(transport.request(request)).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "Paddle Billing is temporarily unavailable.",
    });
  });

  it("enforces its deadline even when a transport ignores abort signals", async () => {
    const transport = new BoundedFetchTransport(
      () => new Promise<Response>(() => {}),
    );
    const started = performance.now();
    await expect(
      transport.request({ ...request, timeout_ms: 20 }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(performance.now() - started).toBeLessThan(500);
  });
});
