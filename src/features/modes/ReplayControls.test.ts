import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { canonicalScript } from '../session/model/canonicalScript';
import { ReplayControls } from './ReplayControls';

const playback = { t: 2, playing: true, speed: 1, play: () => {}, pause: () => {}, toggle: () => {}, seek: () => {}, restart: () => {}, setSpeed: () => {} };
describe('replay pending activity controls', () => {
  it.each([false, true])('shows a labelled indicator and one Back to live action in compact=%s', (compact) => {
    const markup = renderToStaticMarkup(createElement(ReplayControls, { script: canonicalScript, playback, compact, newActivity: true, onBackToLive: () => {} }));
    expect(markup).toContain('New activity');
    expect(markup).toContain('Back to live');
    expect(markup).toContain('role="status"');
  });
  it('adds no indicator or action when the replay is current', () => {
    const markup = renderToStaticMarkup(createElement(ReplayControls, { script: canonicalScript, playback, newActivity: false }));
    expect(markup).not.toContain('New activity');
    expect(markup).not.toContain('Back to live');
  });
});
