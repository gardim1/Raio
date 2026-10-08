import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CoreHealth } from '../../platform/desktopBridge';
import type { ProjectInsights } from '../project/projectInsights';
import { EvidencePanel } from './EvidencePanel';

const evidence: ProjectInsights = {
  note: 'Relationships unknown.', relationships: 'unknown', parallel: false, actors: 1,
  reportedEdits: [], unassigned: [], validations: [],
};
const health = (dropped: number, droppedAtLeast: boolean | undefined): CoreHealth => ({
  dropped, ...(droppedAtLeast === undefined ? {} : { droppedAtLeast }),
  watcherOverflow: false, historyResetFrom: null, hookBinary: 'raio-hook',
});
const warning = (core: CoreHealth | undefined): string | null => {
  const html = renderToStaticMarkup(createElement(EvidencePanel, { evidence, core }));
  return html.match(/<p class="evidence__warn"[^>]*>(.*?)<\/p>/)?.[1] ?? null;
};

describe('dropped-event evidence', () => {
  it.each([
    { name: 'lower bound', dropped: 3, flag: true, expected: 'At least 3 event(s) could not be recorded; this session may be incomplete.' },
    { name: 'exact count', dropped: 3, flag: false, expected: '3 event(s) could not be recorded; this session may be incomplete.' },
    { name: 'legacy count without a flag', dropped: 3, flag: undefined, expected: '3 event(s) could not be recorded; this session may be incomplete.' },
    { name: 'uncounted losses with a zero lower bound', dropped: 0, flag: true, expected: 'Some events may not have been recorded; this session may be incomplete.' },
    { name: 'zero exact count', dropped: 0, flag: false, expected: null },
    { name: 'zero legacy count', dropped: 0, flag: undefined, expected: null },
  ])('shows truthful evidence for $name', ({ dropped, flag, expected }) => {
    expect(warning(health(dropped, flag))).toBe(expected);
  });

  it('does not invent dropped events without core health', () => {
    expect(warning(undefined)).toBeNull();
  });
});

it('keeps partial/stale/import warnings outside the collapsed map details', () => {
  const html = renderToStaticMarkup(createElement(EvidencePanel, { evidence: {
    ...evidence, technologies: ['Frontend · Next.js'],
    note: 'Areas are a heuristic guess from folders and manifests, not verified dependencies. Relationships between areas are unknown. The latest relisting failed, so these areas are as of the last listing. The scan was partial, so some relationships may be missing.',
  }, core: { ...health(3, true), watcherOverflow: true, historyResetFrom: 'history.backup' } }));
  expect(html).toContain('About this map');
  expect(html).toContain('aria-expanded="false"');
  const disclosure = html.slice(html.indexOf('class="map-about"'));
  expect(disclosure).toContain('Frontend · Next.js');
  for (const warning of ['The latest relisting failed', 'The scan was partial', 'At least 3 event(s)', 'The file watcher overflowed', 'Local history was unreadable']) {
    expect(html).toContain(warning); expect(disclosure).not.toContain(warning);
  }
});
