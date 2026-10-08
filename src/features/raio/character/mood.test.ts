import { describe, expect, it } from 'vitest';
import { deriveCompanionPresence, type PresenceFact } from '../../modes/companionPresence';
import { LiveRounds, characterMode, replayCharacterMode } from './mood';
import { factsFromEvents } from '../../modes/presenceFacts';
import type { RaioEvent } from '../../ingest/raioEvent';

describe('character follows factual presence', () => {
  it.each(['connected', 'unknown', 'disconnected'] as const)('%s rests without claiming activity', state => {
    expect(characterMode({ state, label: '', description: '', records: [], activeUntil: null })).toBe('idle');
  });
  it('keeps failure > attention > working > idle and never turns a passing command into celebration', () => {
    const facts: PresenceFact[] = [
      { id: 'a', at: 1000, kind: 'activity', source: 'hook' },
      { id: 'm', at: 1100, kind: 'change', paths: ['db/migrations/001.sql'], change: 'added', source: 'hook' },
      { id: 'f', at: 1200, kind: 'check', checkClass: 'tests', result: 'failed', source: 'hook' },
    ];
    const mode = (fs: PresenceFact[]) => characterMode(deriveCompanionPresence({ connected: true, available: true, facts: fs }, 2000));
    expect(mode([])).toBe('idle'); expect(mode(facts.slice(0, 1))).toBe('working');
    expect(mode(facts.slice(0, 2))).toBe('attention'); expect(mode(facts)).toBe('failure');
    const gate = new LiveRounds(0);
    const laterPass: PresenceFact = { id: 'different-command', at: 1500, kind: 'check', checkClass: 'tests', result: 'passed', source: 'hook' };
    expect(gate.observe([...facts, laterPass], { replay: false, visible: true, now: 2000 })).toEqual([]);
    expect(mode([...facts, laterPass])).toBe('attention');
  });
  it('replay follows the frame and never treats completed as proven tests passed', () => {
    expect(replayCharacterMode({ status: 'failed', activeRisk: {} as never })).toBe('failure');
    expect(replayCharacterMode({ status: 'working', activeRisk: {} as never })).toBe('attention');
    expect(replayCharacterMode({ status: 'working', activeRisk: null })).toBe('working');
    for (const status of ['ready', 'complete', 'finished', 'incomplete'] as const) expect(replayCharacterMode({ status, activeRisk: null })).toBe('idle');
  });
  it('never celebrates a different passing check with indistinguishable minimized metadata', () => {
    // npx vitest a.test and npx vitest b.test have identical retained class/program fields.
    const event = (id: string, at: number, exitCode: number): RaioEvent => ({ schema: 1, id, observedAt: at, seq: at,
      projectId: 'p', sessionId: 's', agent: 'claude', source: 'claude-hook', provenance: 'agent-reported', attribution: 'session',
      kind: 'command.result', paths: [], evidence: { toolUseId: id, program: 'npx', commandClass: 'test', exitCode } });
    const facts = factsFromEvents([event('a', 1000, 1), event('b', 1100, 0)], 'p');
    const gate = new LiveRounds(0);
    expect(gate.observe(facts, { now: 1200, visible: true, replay: false })).toEqual([]);
    expect(characterMode(deriveCompanionPresence({ connected: true, available: true, facts }, 1200))).toBe('working');
  });
});
describe('live round one-shots', () => {
  const turn = (id: string, at: number) => ({ id, at, kind: 'turn-end', source: 'hook' });
  const live = { replay: false, visible: true, now: 1100 };
  it('accepts only new facts at/after mount and dedupes by id', () => {
    const gate = new LiveRounds(1000);
    const facts = [turn('old', 999), turn('new', 1000)];
    expect(gate.observe(facts, live)).toEqual(['round']);
    expect(gate.observe([...facts, turn('new', 1050)], live)).toEqual([]);
    expect(new LiveRounds(1200).observe(facts, { ...live, now: 1300 })).toEqual([]);
  });
  it('drops replay/hidden facts and reconciled hidden backlog, with no queue on show', () => {
    const gate = new LiveRounds(1000);
    expect(gate.observe([turn('replay', 1000)], { ...live, replay: true })).toEqual([]);
    expect(gate.observe([turn('replay', 1000)], live)).toEqual([]);
    gate.visibility(false, 1100);
    expect(gate.observe([turn('hidden', 1150)], { ...live, visible: false, now: 1200 })).toEqual([]);
    gate.visibility(true, 1300);
    expect(gate.observe([turn('hidden', 1150), turn('backlog', 1250)], { ...live, now: 1400 })).toEqual([]);
    expect(gate.observe([turn('fresh', 1400)], { ...live, now: 1400 })).toEqual(['round']);
  });
  it('does not run future-dated or session-ended facts and never emits celebrate', () => {
    const gate = new LiveRounds(1000);
    expect(gate.observe([turn('future', 1300), { id: 'end', at: 1050, kind: 'end' }], live)).toEqual([]);
    expect(gate.observe([turn('future', 1300)], { ...live, now: 1300 })).toEqual(['round']);
  });
});
