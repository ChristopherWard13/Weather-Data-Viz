import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;
// Set E2E_PREBUILT=1 to test an existing dist/ instead of rebuilding it.
const build = process.env.E2E_PREBUILT ? "" : "npm run build && ";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 860 }, deviceScaleFactor: 2 },
    },
  ],
  // Tests run against the production build, served with real pipeline output
  // from ../data (or $WXTREND_DATA_DIR).
  webServer: {
    command: `${build}npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
