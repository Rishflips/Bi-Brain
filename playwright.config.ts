import { defineConfig } from "@playwright/test";
const port = Number(process.env.BRAIN_E2E_PORT ?? 4317);
// A second server with its own fresh database, so specs that need a genuinely
// empty brain do not depend on which other specs ran first.
const emptyPort = Number(process.env.BRAIN_E2E_EMPTY_PORT ?? port + 10);
// The Today v2 spec reloads the page a lot, so it gets its own server and its own
// request budget instead of sharing the per-minute limit with every other spec.
const todayPort = Number(process.env.BRAIN_E2E_TODAY_PORT ?? port + 11);
// The bar and dismissal journeys get a fourth server for the same reason.
const barPort = Number(process.env.BRAIN_E2E_BAR_PORT ?? port + 12);
const stamp = Date.now();
export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  timeout: 30000,
  use: { trace: "retain-on-failure" },
  projects: [
    {
      name: "main",
      testIgnore: /today-v2(-empty|-bar)?\.spec\.ts/,
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
  ],
});
