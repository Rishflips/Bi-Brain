import { createApp } from "./app.ts";
import { dirname, resolve } from "node:path";
const app = await createApp(undefined, { metadataLogs: true });
await app.listen({
  host: process.env.BRAIN_CONTAINER === "1" ? "0.0.0.0" : "127.0.0.1",
  port: Number(process.env.BRAIN_PORT ?? 4317),
});
console.log(
  `Bi Brain: ${process.env.BRAIN_PUBLIC_ORIGIN ?? `http://127.0.0.1:${process.env.BRAIN_PORT ?? 4317}`} — ${process.env.BRAIN_OWNER_SECRET !== undefined ? "installation code supplied by the operator" : `installation code is in ${resolve(dirname(process.env.BRAIN_DB ?? "data/brain.sqlite"), "owner-secret")}`}`,
);
process.on("SIGINT", () => void app.close());
process.on("SIGTERM", () => void app.close());
