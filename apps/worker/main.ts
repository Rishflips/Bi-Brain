import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { BrainError } from "../../packages/domain/logic.ts";
import type { PreparedProvider } from "../../packages/providers/prepared.ts";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { loadConfig } from "../server/config.ts";
import { Worker } from "./engine.ts";
import { ManagedWorker } from "./managed.ts";

const config = loadConfig();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Managed dispatch never contacts a paid provider. Central per-dispatch and
 * aggregate accounting is a separate, unimplemented gate, so a tenant is always
 * served by extractive preparation. If a legacy row left `provider_enabled`
 * set, the attempt fails with an explicit "unavailable" receipt instead of a
 * silent, fake connected result.
 */
const unavailableProvider: PreparedProvider = {
  prepareCall(): never {
    throw new BrainError(
      "PROVIDER_UNAVAILABLE",
      "Connected model processing is not available on managed hosting yet. Your saved work stays available and extractive.",
      503,
    );
  },
};

if (config.mode === "managed") {
  const runtime = new ManagedRuntime(config.managedRoot);
  const worker = new ManagedWorker(runtime, {
    providerFactory: () => unavailableProvider,
  });
  let running = true;
  const stop = () => {
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  while (running) {
    try {
      const worked = await worker.tick();
      if (!worked) await sleep(1000);
    } catch {
      console.error("Managed worker tick failed; retrying.");
      await sleep(2000);
    }
  }
  // No new work starts after SIGTERM: the loop has exited, so wait for any
  // in-flight tenant job, then close the runtime it was pinned against.
  await worker.stop();
  try {
    runtime.close();
  } catch {
    console.error("Managed runtime did not close cleanly; a handle was pinned.");
  }
} else {
  const storage = new Storage();
  const worker = new Worker(new Brain(storage));
  let running = true;
  const stop = () => {
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  while (running) {
    try {
      const worked = await worker.tick();
      if (!worked) await sleep(1000);
    } catch {
      console.error("Worker storage unavailable; retrying.");
      await sleep(2000);
    }
  }
  storage.close();
}
