import { defineConfig } from '@playwright/test';

/**
 * Renderer-only visual tests against the dev harness (fixture data, frozen clock).
 * They do not exercise native windows, tray, focus, transparency or DPI.
 * Goldens are local-only (.local/visual) until the owner decides what may be published.
 */
export default defineConfig({
  testDir: 'tests/visual',
  snapshotPathTemplate: '.local/visual/goldens/{arg}{ext}',
  outputDir: '.local/visual/test-results',
  reporter: [['list']],
  use: {
    channel: 'msedge',
    baseURL: 'http://127.0.0.1:5174',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
  },
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled' } },
  webServer: {
    command: 'npx vite --port 5174 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:5174/harness.html',
    reuseExistingServer: false,
  },
});
