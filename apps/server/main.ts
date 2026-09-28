import { createApp } from "./app.ts";
const app = await createApp(undefined, { metadataLogs: true });
await app.listen({
  host: process.env.BRAIN_CONTAINER === "1" ? "0.0.0.0" : "127.0.0.1",
  port: Number(process.env.BRAIN_PORT ?? 4317),
});
console.log(
  `Bi Brain: http://127.0.0.1:${process.env.BRAIN_PORT ?? 4317} — installation code is in data/owner-secret`,
);
process.on("SIGINT", () => void app.close());
process.on("SIGTERM", () => void app.close());
