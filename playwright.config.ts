import { defineConfig } from "@playwright/test";
const port = Number(process.env.BRAIN_E2E_PORT ?? 4317);
export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  timeout: 30000,
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
  webServer: {
    command: "npm start",
    url: `http://127.0.0.1:${port}/api/v1/health/live`,
    reuseExistingServer: false,
    env: {
      BRAIN_PORT: String(port),
      BRAIN_DB: `data/e2e-${Date.now()}.sqlite`,
      BRAIN_OWNER_SECRET: "e2e-local-only",
    },
    timeout: 30000,
  },
});
