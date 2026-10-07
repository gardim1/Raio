import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentStatus } from '../../shared/ui/AgentStatus';
import { TitleBar } from '../panel/TitleBar';
import { MiniOrb } from '../raio/MiniOrb';
import { deriveCompanionPresence } from './companionPresence';
import { MiniSurface } from './MiniSurface';

const failure = deriveCompanionPresence({ connected: true, available: true, facts: [{ id: 'f', kind: 'check', at: 0, checkClass: 'tests', result: 'failed', source: 'Claude hook' }] }, 60_000, 'UTC');
const quiet = deriveCompanionPresence({ connected: true, available: true, facts: [] }, 60_000);
describe('shared companion presence on existing chrome', () => {
  it('a completed animation cannot turn a failed current check green or hide its source', () => {
    const markup = renderToStaticMarkup(createElement(AgentStatus, { state: 'complete', agent: 'claude', companion: failure }));
    expect(markup).toContain('data-presence="failure"');
    expect(markup).toContain('Tests failed');
    expect(markup).toContain('Claude hook');
  });
  it('uses the same semantic state and accessible description in Expanded and Mini', () => {
    const expanded = renderToStaticMarkup(createElement(TitleBar, { project: 'Fixture', agent: 'claude', task: 'Fixture', taskVisible: true, status: 'working', companion: failure }));
    const mini = renderToStaticMarkup(createElement(MiniSurface, { project: 'Fixture', pinned: false, status: 'working', stateLabel: 'Working', companion: failure, onTogglePin: () => {}, onExpand: () => {}, onCollapse: () => {}, children: null }));
    expect(expanded).toContain('data-presence="failure"');
    expect(mini).toContain('data-presence="failure"');
    expect(mini).toContain('Claude hook');
    expect(mini).toContain('Tests failed');
  });
  it('resting Island/header orbs do not bob even if an old animation asks them to', () => {
    const markup = renderToStaticMarkup(createElement(MiniOrb, { bob: true, companion: quiet }));
    expect(markup).not.toContain('mini-orb--bob');
    expect(markup).toContain('data-presence="connected"');
  });
  it('gives unavailable/disconnected states their own icon plus readable wording', () => {
    for (const connected of [false, true]) {
      const companion = deriveCompanionPresence({ connected, available: false, facts: [] }, 0);
      const markup = renderToStaticMarkup(createElement(AgentStatus, { state: 'ready', agent: 'unknown', companion }));
      expect(markup).toContain(`data-presence="${connected ? 'unknown' : 'disconnected'}"`);
      expect(markup).toContain(connected ? '?' : '−');
      expect(markup).toContain(connected ? 'Status unavailable' : 'Disconnected');
    }
  });
});
