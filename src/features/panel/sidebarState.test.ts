import { describe, expect, it } from 'vitest';
import { projectMap, type ProjectMapSnapshot } from '../project/projectMap';
import { deriveSidebarState, splitMapNotes } from './sidebarState';

const name = 'Pasta com ação e espaços ' + 'muito longa '.repeat(8);
const map = (files: string[], options: { truncated?: boolean; skipped?: number; stale?: boolean } = {}) => projectMap({ id: 'qa', name }, {
  files, manifests: [], truncated: options.truncated ?? false, skipped: options.skipped ?? 0, scannedAtMs: 1,
}, null, { provenance: 'fixture', inventoryStale: options.stale });
const state = (snapshot: ProjectMapSnapshot) => deriveSidebarState({ snapshot });
describe('factual sidebar states', () => {
  it('preserves the literal long folder name and uses a small area count', () => {
    const result = state(map(['package.json']));
    expect(result.projectName).toBe(name); expect(result.areaCount).toBe('1 area');
    expect(result.heading).toBe('Waiting for activity');
    expect(result.message).toBe('Start a new Claude Code session in this folder. Hooks apply to new sessions.');
    expect(result.indicator).toBe('Connected · no activity yet');
  });
  it('pending is not empty and offers no action', () => {
    const result = state(projectMap({ id: 'qa', name }, null, null, { pending: true, provenance: 'fixture' }));
    expect(result.heading).toBe('Mapping project…'); expect(result.action).toBeNull();
  });
  it('only a complete, ready zero-file listing offers another folder', () => {
    expect(state(map([]))).toMatchObject({ heading: 'No code to map yet', action: 'choose-another' });
    const unrecognized = state(map(['readme.md']));
    expect(unrecognized).toMatchObject({ heading: 'No areas recognized', action: null });
    expect(unrecognized.details.join(' ')).toContain('does not recognize');
    expect(state({ ...map([]), listingDetails: undefined }).heading).toBe('No areas recognized');
  });
  it.each([{ truncated: true }, { skipped: 2 }, { stale: true }])('does not call an incomplete zero listing empty: %j', options => {
    const result = state(map([], options));
    expect(result.heading).toBe('Map incomplete'); expect(result.action).toBeNull();
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.details.join(' ')).not.toMatch(/failed|partial|not listed/);
  });
  it('retains every partial/stale warning for a mapped folder', () => {
    const result = state(map(['package.json'], { truncated: true, skipped: 2, stale: true }));
    expect(result.heading).toBe('Waiting for activity');
    expect(result.warnings).toHaveLength(4);
    expect(result.warnings).toContain('2 files or folders not listed; the reason was not recorded by this core.');
  });
  it.each([undefined, 'Access denied by the filesystem'])('unavailable reports only a supplied reason: %s', reason => {
    const result = state(projectMap({ id: 'qa', name }, null, null, { provenance: 'fixture', unavailableReason: reason }));
    expect(result).toMatchObject({ heading: "Couldn't list this folder", action: null, message: reason ?? 'The project listing is unavailable.' });
  });
  it('disconnected routes to Connect without claims of following activity', () => {
    expect(deriveSidebarState({ snapshot: map([]), connected: false })).toMatchObject({ indicator: 'Not connected', heading: 'No project yet', action: 'connect' });
  });
  it('a real session summary replaces first-run instructions', () => {
    expect(deriveSidebarState({ snapshot: map(['package.json']), session: { summary: 'Update validation' } })).toMatchObject({ heading: 'Update validation', message: null, action: null });
  });
  it('uses recorded activity time, not wall time or a working claim', () => {
    const result = deriveSidebarState({ snapshot: map(['package.json']), timeZone: 'UTC', presence: {
      connected: true, available: true, facts: [{ id: 'a', at: Date.UTC(2026, 9, 8, 14, 2), kind: 'change', source: 'watcher' }],
    } });
    expect(result.indicator).toBe('File changed — source unknown · 14:02');
  });
  it('labels watcher-only changes as unknown source instead of last activity', () => {
    const at = Date.UTC(2026, 9, 8, 14, 2);
    const result = deriveSidebarState({ snapshot: map(['package.json']), timeZone: 'UTC', now:at, integration: {
      hooks:'current', hookBinary:true, heartbeatAgeMs:60_000, inertMarkerAt:null, lastHookEventAt:null,
      lastHookSessionId:null, lastWatcherChangeAt:at,
    }, presence:{ connected:true, available:true, facts:[{ id:'watcher', at, kind:'change', source:'watcher' }] } });
    expect(result.indicator).toBe('File changed — source unknown · 14:02');
    expect(result.indicator).not.toContain('Last activity');
  });
  it('distinguishes configured integration waiting for its first Claude event', () => {
    const result = deriveSidebarState({ snapshot: map(['package.json']), integration: {
      hooks:'current', hookBinary:true, heartbeatAgeMs:60_000, inertMarkerAt:null, lastHookEventAt:null,
      lastHookSessionId:null, lastWatcherChangeAt:null,
    } });
    expect(result.indicator).toBe('Integration configured · waiting for the first Claude event');
  });
  it('shows the last observed hook event and short session identifier', () => {
    const at = Date.UTC(2026, 9, 8, 14, 2);
    const result = deriveSidebarState({ snapshot: map(['package.json']), timeZone:'UTC', now:at, integration: {
      hooks:'current', hookBinary:true, heartbeatAgeMs:60_000, inertMarkerAt:null, lastHookEventAt:at,
      lastHookSessionId:'session-123456789', lastWatcherChangeAt:null,
    } });
    expect(result.indicator).toBe('Following session session-1 · last event 14:02');
  });
  it('reports an inert heartbeat as an integration problem with one next action', () => {
    const result = deriveSidebarState({ snapshot: map(['package.json']), integration: {
      hooks:'current', hookBinary:true, heartbeatAgeMs:8 * 24 * 60 * 60 * 1000, inertMarkerAt:Date.UTC(2026, 9, 8),
      lastHookEventAt:null, lastHookSessionId:null, lastWatcherChangeAt:null,
    } });
    expect(result.indicator).toContain('Integration problem:');
    expect(result.message).toContain('Raio was not running');
    expect(result.message).toContain('New events are recorded now');
  });
  it.each([
    [{ hooks:'outdated', hookBinary:true }, 'Integration problem: Hooks out of date'],
    [{ hooks:'missing', hookBinary:true }, 'Integration problem: Hooks missing'],
    [{ hooks:'unknown', hookBinary:true }, 'Integration problem: Hook status unknown'],
    [{ hooks:'unknown', hookBinary:false }, 'Integration problem: Hook status unknown'],
    [{ hooks:'current', hookBinary:false }, 'Integration problem: raio-hook.exe missing next to raio.exe'],
  ] as const)('shows a specific integration problem for %j', (partial, expected) => {
    const result = deriveSidebarState({ snapshot:map(['package.json']), integration:{
      ...partial, heartbeatAgeMs:60_000, inertMarkerAt:null, lastHookEventAt:null, lastHookSessionId:null, lastWatcherChangeAt:null,
    } });
    expect(result.indicator).toBe(expected);
  });
  it('labels an old Claude event as no recent activity while preserving its time', () => {
    const at = Date.UTC(2026, 9, 8, 14, 2);
    const result = deriveSidebarState({ snapshot:map(['package.json']), timeZone:'UTC', now:at + 10 * 60_000, integration:{
      hooks:'current', hookBinary:true, heartbeatAgeMs:60_000, inertMarkerAt:null, lastHookEventAt:at,
      lastHookSessionId:'session-old', lastWatcherChangeAt:null,
    } });
    expect(result.indicator).toBe('No recent activity · last event 14:02');
  });
  it.each([null, { dropped: 0, watcherOverflow: false, historyResetFrom: null, hookBinary: null }])('does not claim waiting when reception is broken: %j', core => {
    const result = state({ ...map(['package.json']), core });
    expect(result.heading).toBe('Activity cannot be confirmed'); expect(result.message).toBeNull();
    expect(result.warnings).toHaveLength(1);
  });
  it('outdated hooks suppress first-run instructions and have a truthful indicator', () => {
    const result = deriveSidebarState({ snapshot: map(['package.json']), hooks: 'outdated' });
    expect(result).toMatchObject({ indicator: 'Hooks out of date', heading: 'Activity cannot be confirmed', message: null });
  });
  it('preserves dropped events, overflow and history reset outside details', () => {
    const result = state({ ...map(['package.json']), core: { dropped: 3, droppedAtLeast: true, watcherOverflow: true, historyResetFrom: 'backup', hookBinary: 'raio-hook' } });
    expect(result.warnings).toHaveLength(3); expect(result.warnings.join(' ')).toMatch(/At least 3.*overflowed.*unreadable/);
  });
});

it('collapses known explanations only, retaining unfamiliar failures and all scan/listing warnings', () => {
  const result = splitMapNotes('Areas are a heuristic guess from folders and manifests, not verified dependencies. Relationships: static imports between areas (heuristic). 2 pairs of areas import each other; the line points the way with more imports. 3 import specifiers were not resolved (packages, aliases, non-script or missing files). The latest rescan failed, so these relationships are as of the last scan. The scan was partial, so some relationships may be missing. 1 file or folder not read (large, unreadable or online-only). A new failure kind.');
  expect(result.details).toHaveLength(4); expect(result.warnings).toHaveLength(4);
  expect(result.warnings.at(-1)).toBe('A new failure kind.');
});
