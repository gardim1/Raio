import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BOB_ITERATIONS, BOB_PERIOD_SECONDS, BOB_TOTAL_SECONDS } from './bob';
import { MiniOrb } from './MiniOrb';

// vitest empties `.css?raw` and the project has no Node typings, so read the stylesheet through a dynamic specifier.
const NODE_FS = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ NODE_FS)) as { readFileSync: (path: URL, encoding: 'utf8') => string };
const css = readFileSync(new URL('../../app/styles/raio.css', import.meta.url), 'utf8');

const rule = (selector: string): string => {
  const match = css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`rule ${selector} not found`);
  return match[1] ?? '';
};

describe('quiet rest replaces BOB-1 drawing, without changing presence recency', () => {
  it('preserves the legacy 30 s exports used by companion activity', () => {
    expect(BOB_PERIOD_SECONDS).toBe(3);
    expect(BOB_ITERATIONS).toBe(10);
    expect(BOB_TOTAL_SECONDS).toBe(30);
  });

  it('removes the CSS float drawing and leaves the wrapper without an animation', () => {
    expect(rule('.mini-orb')).not.toMatch(/animation|gradient/);
    expect(css).not.toContain('@keyframes raio-bob');
    expect(css).not.toMatch(/\.mini-orb--bob\s*\{/);
  });

  it('uses no CSS animation for the shared SVG, including reduced motion', () => {
    expect(rule('.raio-char')).not.toMatch(/animation/);
    expect(rule('.mini-orb > .raio-char')).not.toMatch(/animation/);
  });
});

describe('MiniOrb', () => {
  it('keeps its drag exclusion wrapper and accepts old props without starting a float', () => {
    const markup = renderToStaticMarkup(createElement(MiniOrb, { bob: true, size: 14, glow: 1, warm: 1, restartKey: 'old' }));
    expect(markup).toContain('class="mini-orb"');
    expect(markup).toContain('width:14px;height:14px;--raio-char-box:28px');
    expect(markup).toContain('raio-char--island');
    expect(markup).toContain('data-character-mode="idle"');
    expect(markup).not.toContain('mini-orb--bob');
  });
});

it.each(['connected', 'attention', 'failure', 'unknown', 'disconnected', 'working'] as const)('character follows %s presence independently of legacy bob', state => {
  const companion = { state, label: state, description: state, records: [], activeUntil: null };
  const markup = renderToStaticMarkup(createElement(MiniOrb, { bob: true, companion }));
  expect(markup).not.toContain('mini-orb--bob');
  expect(markup).toContain(`data-presence="${state}"`);
  expect(markup).toContain(`data-character-mode="${state === 'connected' || state === 'unknown' || state === 'disconnected' ? 'idle' : state}"`);
  expect(markup).toBe(renderToStaticMarkup(createElement(MiniOrb, { bob: false, companion })));
});
