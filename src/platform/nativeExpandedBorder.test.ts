import { expect, it } from 'vitest';

// Same stylesheet-reading pattern as bob.test.ts; this guards CSS scope, not native pixels.
const NODE_FS = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ NODE_FS)) as { readFileSync: (path: URL, encoding: 'utf8') => string };
const css = readFileSync(new URL('./native.css', import.meta.url), 'utf8');

it('removes only native Expanded outer CSS border without resetting its glass shadow', () => {
  const body = css.match(/(?:^|\n)html\.native\.surface-expanded \.panel\.expanded\s*\{([^}]*)\}/)?.[1];
  expect(body).toBeDefined();
  expect(body).toMatch(/(?:^|;)\s*border:\s*(?:0|none)\s*;/);
  // The inset top highlight comes from the panel shadow, so it must continue to inherit.
  expect(body).not.toMatch(/(?:^|;)\s*(?:box-shadow|all|border-(?:top|left|right|bottom))\s*:/);
});
