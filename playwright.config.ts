import { defineConfig } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
const port = Number(process.env.BRAIN_E2E_PORT ?? 4317);
// A second server with its own fresh database, so specs that need a genuinely
// empty brain do not depend on which other specs ran first.
const emptyPort = Number(process.env.BRAIN_E2E_EMPTY_PORT ?? port + 10);
// The Today v2 spec reloads the page a lot, so it gets its own server and its own
// request budget instead of sharing the per-minute limit with every other spec.
const todayPort = Number(process.env.BRAIN_E2E_TODAY_PORT ?? port + 11);
// The bar and dismissal journeys get a fourth server for the same reason.
const barPort = Number(process.env.BRAIN_E2E_BAR_PORT ?? port + 12);
// Connections v2 gets its own server and a fake home that holds only .codex, so Codex
// looks installed and the other agents do not.
const connectionsPort = Number(process.env.BRAIN_E2E_CONNECTIONS_PORT ?? port + 13);
// Sorting help gets its own server plus a loopback stand-in for the sorting service.
const sortingPort = Number(process.env.BRAIN_E2E_SORTING_PORT ?? port + 14);
const clefPort = Number(process.env.BRAIN_E2E_CLEF_PORT ?? port + 15);
// Better search gets a loopback stand-in for the embedding service, used by the same server as sorting help.
const embedPort = Number(process.env.BRAIN_E2E_EMBED_PORT ?? port + 16);
const stamp = Date.now();
const agentHome = resolve("data", `e2e-agent-home-${stamp}`);
mkdirSync(join(agentHome, ".codex"), { recursive: true });
export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  timeout: 30000,
  use: { trace: "retain-on-failure" },
  projects: [
    {
      name: "main",
      testIgnore: /(today-v2(-empty|-bar)?|connections-v2|system-one|better-search)\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${port}` },
    },
    {
      name: "today-v2",
      testMatch: /today-v2\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${todayPort}` },
    },
    {
      name: "today-v2-bar",
      testMatch: /today-v2-bar\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${barPort}` },
    },
    {
      name: "connections",
      testMatch: /connections-v2\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${connectionsPort}` },
    },
    {
      name: "system1",
      testMatch: /(system-one|better-search)\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${sortingPort}` },
    },
    {
      name: "empty-brain",
      testMatch: /today-v2-empty\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${emptyPort}` },
    },
  ],
  webServer: [
    {
      command: "npm start",
      url: `http://127.0.0.1:${port}/api/v1/health/live`,
      reuseExistingServer: false,
      env: {
        BRAIN_PORT: String(port),
        BRAIN_DB: `data/e2e-${stamp}.sqlite`,
        BRAIN_OWNER_SECRET: "e2e-local-only",
      },
      timeout: 30000,
    },
    {
      command: "npm start",
      url: `http://127.0.0.1:${emptyPort}/api/v1/health/live`,
      reuseExistingServer: false,
      env: {
        BRAIN_PORT: String(emptyPort),
        BRAIN_DB: `data/e2e-empty-${stamp}.sqlite`,
        BRAIN_OWNER_SECRET: "e2e-local-only",
      },
      timeout: 30000,
    },
    {
      command: "npm start",
      url: `http://127.0.0.1:${todayPort}/api/v1/health/live`,
      reuseExistingServer: false,
      env: {
        BRAIN_PORT: String(todayPort),
        BRAIN_DB: `data/e2e-today-${stamp}.sqlite`,
        BRAIN_OWNER_SECRET: "e2e-local-only",
      },
      timeout: 30000,
    },
    {
      command: "npm start",
      url: `http://127.0.0.1:${barPort}/api/v1/health/live`,
      reuseExistingServer: false,
      env: {
        BRAIN_PORT: String(barPort),
        BRAIN_DB: `data/e2e-bar-${stamp}.sqlite`,
        BRAIN_OWNER_SECRET: "e2e-local-only",
      },
      timeout: 30000,
    },
    {
      command: "npm start",
      url: `http://127.0.0.1:${connectionsPort}/api/v1/health/live`,
      reuseExistingServer: false,
      env: {
        BRAIN_PORT: String(connectionsPort),
        BRAIN_DB: `data/e2e-connections-${stamp}.sqlite`,
        BRAIN_OWNER_SECRET: "e2e-local-only",
        BRAIN_AGENT_HOME: agentHome,
        BRAIN_AGENT_PATH: "",
      },
      timeout: 30000,
    },
    {
      command: "node tests/helpers/fake-clef.mjs",
      port: clefPort,
      reuseExistingServer: false,
      env: { BRAIN_FAKE_CLEF_PORT: String(clefPort) },
      timeout: 30000,
    },
    {
      command: "node tests/helpers/fake-embed.mjs",
      port: embedPort,
      reuseExistingServer: false,
      env: { BRAIN_FAKE_EMBED_PORT: String(embedPort) },
      timeout: 30000,
    },
    {
      command: "npm start",
      url: `http://127.0.0.1:${sortingPort}/api/v1/health/live`,
      reuseExistingServer: false,
      env: {
        BRAIN_PORT: String(sortingPort),
        BRAIN_DB: `data/e2e-sorting-${stamp}.sqlite`,
        BRAIN_OWNER_SECRET: "e2e-local-only",
        BRAIN_SYSTEM1_PROVIDER: "ollama",
        BRAIN_SYSTEM1_ENDPOINT: `http://127.0.0.1:${clefPort}/v1/systemone`,
        BRAIN_EMBED_PROVIDER: "ollama",
        BRAIN_EMBED_MODEL: "fake-concept-v1",
        BRAIN_EMBED_ENDPOINT: `http://127.0.0.1:${embedPort}/api/embed`,
      },
      timeout: 30000,
    },
  ],
});
