import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { Worker } from "./engine.ts";
const storage = new Storage();
const worker = new Worker(new Brain(storage));
let running = true;
process.on("SIGINT", () => {
  running = false;
});
process.on("SIGTERM", () => {
  running = false;
});
while (running) {
  try {
    const worked = await worker.tick();
    if (!worked) await new Promise((r) => setTimeout(r, 1000));
  } catch {
    console.error("Worker storage unavailable; retrying.");
    await new Promise((r) => setTimeout(r, 2000));
  }
}
storage.close();
