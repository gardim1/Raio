import { describe, expect, it } from 'vitest';
import { CharacterBenchSequence } from './CharacterBench';
describe('simulated character bench sequence', () => {
  it('fails, reruns at 1.9 s, celebrates at 3.4 s and returns to waiting at 6.2 s', () => {
    const states: string[] = [], reactions: string[] = [];
    const sequence = new CharacterBenchSequence();
    sequence.start(mode => states.push(mode), kind => reactions.push(kind));
    expect(states).toEqual(['failure']);
    sequence.update(1.9); expect(states).toEqual(['failure', 'working']);
    sequence.update(1.5); expect(states).toEqual(['failure', 'working', 'passed']); expect(reactions).toEqual(['celebrate']);
    expect(sequence.update(2.8)).toBe(false); expect(states.at(-1)).toBe('idle');
  });
  it('cancels every pending callback on another state or unmount', () => {
    const states: string[] = [], reactions: string[] = [];
    const sequence = new CharacterBenchSequence();
    sequence.start(mode => states.push(mode), kind => reactions.push(kind)); sequence.cancel();
    expect(sequence.update(10)).toBe(false); expect(states).toEqual(['failure']); expect(reactions).toEqual([]);
  });
});
