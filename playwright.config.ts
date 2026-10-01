import { defineConfig } from '@playwright/test';

/** Separate worktrees can run visual tests side by side by choosing different ports. */
const PORT = Number(process.env.RAIO_VISUAL_PORT ?? 5174);

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
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
  },
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.0005, animations: 'disabled' } },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/harness.html`,
    reuseExistingServer: false,
  },
});
