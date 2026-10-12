import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;
// The build reads data from ./data/ (the preview server's local data), never
// the production R2 bucket in .env.production. Set E2E_PREBUILT=1 to test an
// existing dist/ instead, built the same way.
const build = process.env.E2E_PREBUILT ? "" : "VITE_DATA_BASE=data/ npm run build && ";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    // Times show in the browser's zone when it's a US one; UTC keeps titles the same everywhere
    timezoneId: "UTC",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 860 }, deviceScaleFactor: 2 },
    },
  ],
  // Tests run against the production build, served with real pipeline output
  // from ../data/gfs/ (or $WXTREND_DATA_DIR/gfs/; CI uses the small dataset
  // from `make e2e-data`).
  webServer: {
    command: `${build}npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
