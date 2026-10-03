import { defineConfig } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    acceptDownloads: true,
    viewport: { width: 1280, height: 1000 },
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  webServer: {
    command: 'node server.js',
    url: `http://127.0.0.1:${PORT}/api/config`,
    reuseExistingServer: !process.env.CI,
    env: {
      PORT: String(PORT),
      // The browser-side API calls are mocked in the tests; the server never calls Anthropic.
      ANTHROPIC_API_KEY: 'test-key-not-used',
      BOOKING_URL: 'https://cal.example.com/marketedge',
    },
  },
});
