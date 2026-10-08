import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ClaudeUsageState } from '../claudeUsage';
import { UsageRings } from './UsageRings';
import { UsageDetails } from './UsageDetails';
import { startUsageClock } from './usageClock';
import { readClaudeUsage } from './useClaudeUsage';

const now = Date.UTC(2026, 9, 8, 12);
const reading: Extract<ClaudeUsageState, { status: 'reading' }> = { status: 'reading', sourceCount: 2, latest: {
  source: { kind: 'claude-statusline', projectId: 'demo', sessionId: 'abcdef12-other-private-id' }, receivedAtMs: now - 120_000,
  fiveHour: { usedPercentage: 23.5, resetsAtMs: now + 3600_000 }, sevenDay: { usedPercentage: 78, resetsAtMs: now + 86400_000 },
} };
const markup = (state: ClaudeUsageState, compact = false) => renderToStaticMarkup(createElement(UsageRings, { state, nowMs: now, compact }));
describe('Claude plan usage rings', () => {
  it('draws independent USED percentages with five-hour inside weekly and an accessible details button', () => {
    const html = markup(reading);
    expect(html).toContain('aria-label="Claude plan usage"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/data-window="fiveHour"[^>]*r="10"[^>]*stroke-dasharray="23.5 100"/);
    expect(html).toMatch(/data-window="sevenDay"[^>]*r="16"[^>]*stroke-dasharray="78 100"/);
    expect(html).not.toContain('data-character');
    expect(markup(reading, true)).toContain('usage-rings--compact');
  });
  it('never turns missing or expired windows into zero-percent rings', () => {
    const state = { ...reading, latest: { ...reading.latest, fiveHour: undefined, sevenDay: { usedPercentage: 78, resetsAtMs: now } } };
    const html = markup(state);
    expect(html).not.toContain('stroke-dasharray');
    expect(html).toContain('Usage unavailable');
    expect(html).toContain('data-kind="missing"');
    expect(html).toContain('data-kind="expired"');
    const one = markup({ ...reading, latest: { ...reading.latest, fiveHour: undefined } });
    expect(one).not.toContain('data-window="fiveHour" r=');
    expect(one).toContain('stroke-dasharray="78 100"');
  });
  it('visibly marks stale values, preserves reported zero, and explains age and multiple sources', () => {
    const stale = { ...reading, latest: { ...reading.latest, receivedAtMs: now - 16 * 60_000, fiveHour: { usedPercentage: 0, resetsAtMs: null } } };
    expect(markup(stale)).toContain('usage-rings--stale');
    expect(markup(stale)).toContain('stroke-dasharray="0 100"');
    const details = renderToStaticMarkup(createElement(UsageDetails, { state: stale, nowMs: now, id: 'details' }));
    expect(details).toContain('5-hour limit · 0% used · reset time unavailable');
    expect(details).toContain('Weekly limit · 78% used · resets');
    expect(details).toContain('Updated 16 minutes ago');
    expect(details).toContain('Source Claude Code session abcdef12');
    expect(details).toContain('latest of 2 sources');
    expect(details).not.toContain('other-private-id');
    expect(details).toContain('Stale reading');
  });
  it.each<ClaudeUsageState>([{ status: 'waiting' }, { status: 'incompatible', reason: 'Existing status line' }, { status: 'error', reason: 'Cannot read usage' }, { status: 'disabled' }])('explains $status without implying a zero reading', state => {
    expect(markup(state)).toContain('Usage unavailable');
    expect(markup(state)).not.toContain('stroke-dasharray');
    const html = renderToStaticMarkup(createElement(UsageDetails, { state, nowMs: now, id: 'details' }));
    if (state.status === 'incompatible' || state.status === 'error') expect(html).toContain(state.reason);
    if (state.status === 'waiting') expect(html).toContain('Waiting for Claude Code to report plan limits');
    if (state.status === 'disabled') expect(html).toContain('Plan usage is not enabled for this project');
  });
  it('reads only the optional bridge getter, leaving missing integration disabled', () => {
    expect(readClaudeUsage({})).toEqual({ status: 'disabled' });
    expect(readClaudeUsage({ claudeUsage: () => reading })).toBe(reading);
  });
});

describe('visible-only usage age clock', () => {
  it('ticks at most once a minute, cancels while hidden, refreshes on show, and cleans up', () => {
    let visible = true, listener: (() => void) | undefined, timer: (() => void) | undefined, updates = 0, subscriptions = 0;
    const stop = startUsageClock(() => { updates++; }, {
      visible: () => visible,
      subscribeVisibility: callback => { subscriptions++; listener = callback; return () => { subscriptions--; listener = undefined; }; },
      afterMinute: callback => { expect(timer).toBeUndefined(); timer = callback; return () => { timer = undefined; }; },
    });
    expect(updates).toBe(1);
    const first = timer; timer = undefined; first?.();
    expect(updates).toBe(2);
    visible = false; listener?.();
    expect(timer).toBeUndefined();
    expect(updates).toBe(2);
    visible = true; listener?.();
    expect(updates).toBe(3);
    stop();
    expect(timer).toBeUndefined(); expect(subscriptions).toBe(0);
  });
});
