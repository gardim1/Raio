import { describe, expect, it } from 'vitest';
import { deriveCompanionPresence, type PresenceFact, type PresenceInput } from './companionPresence';

const at = Date.parse('2026-10-07T14:02:00Z');
const fact = (id: string, kind: PresenceFact['kind'], offset = 0, extra: Partial<PresenceFact> = {}): PresenceFact => ({ id, kind, at: at + offset, sessionId: 'a', source: 'Claude hook', ...extra });
const input = (facts: readonly PresenceFact[], extra: Partial<PresenceInput> = {}): PresenceInput => ({ connected: true, available: true, facts, ...extra });
const derive = (facts: readonly PresenceFact[], now = at + 60_000, extra: Partial<PresenceInput> = {}) => deriveCompanionPresence(input(facts, extra), now, 'UTC');

describe('companion presence from observed facts', () => {
  it('keeps a quiet connection neutral without implying checks passed', () => {
    const result = derive([fact('s', 'start')]);
    expect(result.state).toBe('connected');
    expect(result.label).toBe('Connected · quiet');
    expect(result.activeUntil).toBeNull();
  });
  it('distinguishes disconnection from unavailable data', () => {
    expect(derive([], at, { connected: false }).state).toBe('disconnected');
    expect(derive([], at, { available: false }).state).toBe('unknown');
    expect(derive([], at, { available: false }).label).toContain('unavailable');
  });
  it('shows recent observed activity only within the existing bounded live window', () => {
    const facts = [fact('s', 'start'), fact('r', 'activity')];
    expect(derive(facts, at + 29_000).state).toBe('working');
    expect(derive(facts, at + 30_000).state).toBe('connected');
    expect(derive(facts, at - 1).state).not.toBe('working');
    expect(derive(facts, at + 1000).activeUntil).toBe(at + 30_000);
  });
  it('keeps an unsuperseded check failure red in the latest ended session with time and provenance', () => {
    const result = derive([fact('s', 'start'), fact('f', 'check', 0, { checkClass: 'tests', result: 'failed' }), fact('e', 'end', 1000)]);
    expect(result.state).toBe('failure');
    expect(result.label).toBe('Tests failed · 14:02');
    expect(result.description).toContain('Claude hook');
    expect(result.records[0]?.historical).toBe(false);
  });
  it('does not let a different check or an unknown result erase a failure', () => {
    const failed = fact('f', 'check', 1, { checkClass: 'tests', result: 'failed' });
    expect(derive([failed, fact('b', 'check', 2, { checkClass: 'build', result: 'passed' })]).state).toBe('failure');
    expect(derive([failed, fact('u', 'check', 2, { checkClass: 'tests', result: 'unknown' })]).state).toBe('failure');
  });
  it('a later pass of the same class reduces emphasis but preserves the failure record', () => {
    const result = derive([fact('f', 'check', 1, { checkClass: 'tests', result: 'failed' }), fact('p', 'check', 2, { checkClass: 'tests', result: 'passed' })]);
    expect(result.state).toBe('connected');
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.label).toContain('later pass recorded');
    expect(result.records[0]?.historical).toBe(true);
  });
  it('a code change makes a failure historical without changing its recorded outcome', () => {
    const result = derive([fact('f', 'check', 0, { checkClass: 'tests', result: 'failed' }), fact('c', 'change', 1, { paths: ['src/a.ts'], change: 'modified' })]);
    expect(result.state).toBe('connected');
    expect(result.records[0]?.label).toContain('Failed earlier · code changed since');
    expect(result.records[0]?.historical).toBe(true);
  });
  it('keeps older-session failures historical when a new session opens', () => {
    const result = derive([fact('s', 'start'), fact('f', 'check', 1, { checkClass: 'build', result: 'failed' }), fact('e', 'end', 2), fact('n', 'start', 3, { sessionId: 'b' })]);
    expect(result.state).toBe('connected');
    expect(result.records[0]?.label).toContain('earlier session');
  });
  it('unions current concurrent sessions without claiming causality', () => {
    const result = derive([fact('a', 'start'), fact('b', 'start', 1, { sessionId: 'b' }), fact('f', 'check', 2, { checkClass: 'tests', result: 'failed', sessionId: 'a' }), fact('r', 'activity', 3, { sessionId: 'b' })], at + 10);
    expect(result.state).toBe('failure');
    expect(result.records[0]?.source).toBe('Claude hook');
  });
  it('includes failed edits with their path and source', () => {
    const result = derive([fact('f', 'edit-failed', 0, { paths: ['src/a.ts'] })]);
    expect(result.state).toBe('failure');
    expect(result.label).toContain('Edit failed');
    expect(result.description).toContain('src/a.ts');
  });
  it.each([
    ['.env.local', 'modified', 'Sensitive file changed'],
    ['db/migrations/001.sql', 'added', 'Migration file added'],
    ['package.json', 'modified', 'Dependency manifest changed'],
  ] as const)('flags factual changes to %s, never claims execution', (path, change, label) => {
    const result = derive([fact('c', 'change', 0, { paths: [path], change })]);
    expect(result.state).toBe('attention');
    expect(result.label).toContain(label);
  });
  it('does not call a modified migration added or arbitrary command text destruction', () => {
    expect(derive([fact('c', 'change', 0, { paths: ['db/migrations/001.sql'], change: 'modified' })]).state).toBe('connected');
    expect(derive([fact('r', 'activity', 0, { source: 'rm delete fixture' })]).state).toBe('connected');
  });
  it.each([{ dropped: 1 }, { dropped: 0, droppedAtLeast: true }, { watcherOverflow: true }, { historyResetFrom: 'fixture-reset' }])('flags gaps and unrecorded history: %s', (extra) => {
    const core = { dropped: 0, watcherOverflow: false, historyResetFrom: null, hookBinary: 'fixture', ...extra };
    expect(derive([], at, { core }).state).toBe('attention');
  });
  it('uses failure > attention > activity > quiet and retains all evidence', () => {
    const changes = fact('c', 'change', 0, { paths: ['package.json'], change: 'modified' });
    const failed = fact('f', 'check', 1, { checkClass: 'tests', result: 'failed' });
    const result = derive([changes, failed], at + 2, { hooks: 'outdated' });
    expect(result.state).toBe('failure');
    expect(result.records).toHaveLength(3);
    expect(derive([changes], at + 2).state).toBe('attention');
    expect(derive([], at, { hooks: 'outdated' }).label).toBe('Hooks outdated');
  });
});
