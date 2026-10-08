import { describe, expect, it } from 'vitest';
import type { RaioEvent } from '../ingest/raioEvent';
import { deriveCompanionPresence } from './companionPresence';
import { factsFromEvents, factsFromLog } from './presenceFacts';

const event = (seq: number, kind: RaioEvent['kind'], extra: Partial<RaioEvent> = {}): RaioEvent => ({ schema: 1, id: String(seq), projectId: 'p', sessionId: 's', agent: 'claude', source: 'claude-hook', provenance: 'agent-reported', attribution: 'session', observedAt: seq * 1000, seq, kind, paths: [], evidence: {}, ...extra });
describe('presence at the recorded-event boundary', () => {
  it('distinguishes a hook or fixture turn end without changing activity recency or ending the session', () => {
    for (const source of ['claude-hook', 'fixture'] as const) {
      const facts = factsFromEvents([event(1, 'session.started'), event(2, 'turn.ended', { source })], 'p');
      expect(facts.map(f => f.kind)).toEqual(['start', 'turn-end']);
      const input = { connected: true, available: true, facts };
      const original = { ...input, facts: facts.map(f => f.kind === 'turn-end' ? { ...f, kind: 'activity' as const } : f) };
      expect(deriveCompanionPresence(input, 2001)).toEqual(deriveCompanionPresence(original, 2001));
      expect(deriveCompanionPresence(input, 2001).activeUntil).toBe(32_000);
      expect(deriveCompanionPresence(input, 32_000).state).toBe('connected');
    }
  });
  it('pairs a failure-message result to its observed check without inventing a numeric result', () => {
    const facts = factsFromEvents([event(1, 'command.observed', { evidence: { commandClass: 'test', toolUseId: 't' } }), event(2, 'command.result', { evidence: { toolUseId: 't', exitCode: 7, exitCodeSource: 'failure-message' } })], 'p');
    const presence = deriveCompanionPresence({ connected: true, available: true, facts }, 60_000, 'UTC');
    expect(presence.state).toBe('failure');
    expect(presence.label).toContain('Tests failed');
    expect(presence.description).toContain('failure message');
    const unknown = factsFromEvents([event(3, 'command.result', { evidence: { commandClass: 'test', detail: 'result not established' } })], 'p');
    expect(deriveCompanionPresence({ connected: true, available: true, facts: unknown }, 60_000).state).toBe('connected');
  });
  it('does not mix tool-use ids across sessions or actors or include another project', () => {
    const facts = factsFromEvents([
      event(1, 'command.observed', { sessionId: 'old', evidence: { toolUseId: 't', commandClass: 'test' } }),
      event(2, 'command.result', { sessionId: 'new', evidence: { toolUseId: 't', exitCode: 1 } }),
      event(3, 'command.result', { subagentId: 'other', evidence: { toolUseId: 't', exitCode: 1 } }),
      event(4, 'file.edit.failed', { projectId: 'different', paths: ['secret.ts'] }),
    ], 'p');
    expect(facts).toHaveLength(3);
    expect(facts[1]?.checkClass).not.toBe('tests');
    expect(facts[2]?.checkClass).not.toBe('tests');
  });
  it('keeps watcher changes unassigned and does not call a failed edit a write', () => {
    const facts = factsFromEvents([event(1, 'file.edit.failed', { paths: ['src/a.ts'] }), event(2, 'file.changed', { sessionId: undefined, source: 'fs-watch', provenance: 'filesystem-observed', attribution: 'unassigned', paths: ['.env'], evidence: { change: 'modified' } })], 'p');
    expect(facts.map((fact) => fact.kind)).toEqual(['edit-failed', 'change']);
    expect(facts[1]?.sessionId).toBeUndefined();
    expect(facts[1]?.source).toContain('Filesystem');
  });
  it('uses normalized fixture/older-adapter log facts with absolute recorded time', () => {
    const facts = factsFromLog({ id: 's', agent: 'claude', project: 'p', task: 'Fixture', startedAt: '2026-10-07T14:02:00Z', events: [{ kind: 'session.start', atMs: 0 }, { kind: 'file.write', atMs: 1000, path: 'db/migrations/001.sql', nodeId: 'db', change: 'added' }, { kind: 'validation', atMs: 2000, validation: 'tests', status: 'failed' }] });
    expect(facts.map((fact) => fact.kind)).toEqual(['start', 'change', 'check']);
    expect(facts[2]?.at).toBe(Date.parse('2026-10-07T14:02:02Z'));
    expect(facts[2]?.result).toBe('failed');
  });
});
