import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  timeout: 30000,
  use: { baseURL: "http://127.0.0.1:4317", trace: "retain-on-failure" },
  webServer: {
    command: "npm start",
    url: "http://127.0.0.1:4317/api/v1/health/live",
    reuseExistingServer: false,
    env: {
      BRAIN_DB: `data/e2e-${Date.now()}.sqlite`,
      BRAIN_OWNER_SECRET: "e2e-local-only",
    },
    timeout: 30000,
  },
});
