import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [["line"]],
  use: {
    headless: true,
    viewport: { width: 1_440, height: 1_000 },
    trace: "retain-on-failure",
  },
});
