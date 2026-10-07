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

describe('bounded idle float (BOB-1)', () => {
  it('plays about 30 s: 10 iterations of the original 3 s period', () => {
    expect(BOB_PERIOD_SECONDS).toBe(3);
    expect(BOB_ITERATIONS).toBe(10);
    expect(BOB_TOTAL_SECONDS).toBe(30);
  });

  it('keeps keyframes, easing and period, only bounding the iteration count', () => {
    const body = rule('.mini-orb--bob');
    expect(body).toContain(`animation: raio-bob ${BOB_PERIOD_SECONDS}s ease-in-out ${BOB_ITERATIONS}`);
    expect(body).not.toMatch(/infinite/);
    expect(css).toMatch(/@keyframes raio-bob \{ 50% \{ transform: translateY\(-3px\); \} \}/);
  });

  it('still has no float under reduced motion', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.mini-orb--bob[^{]*\{[^}]*animation: none/);
  });
});

describe('MiniOrb', () => {
  it('bobs only when asked', () => {
    expect(renderToStaticMarkup(createElement(MiniOrb, { bob: true }))).toContain('mini-orb--bob');
    expect(renderToStaticMarkup(createElement(MiniOrb, {}))).not.toContain('mini-orb--bob');
  });
});

it.each(['connected', 'attention', 'failure', 'unknown', 'disconnected'] as const)('bounded float respects bob alone for %s presence', state => {
  const companion = { state, label: state, description: state, records: [], activeUntil: null };
  expect(renderToStaticMarkup(createElement(MiniOrb, { bob: true, companion }))).toContain('mini-orb--bob');
  expect(renderToStaticMarkup(createElement(MiniOrb, { bob: false, companion }))).not.toContain('mini-orb--bob');
});
