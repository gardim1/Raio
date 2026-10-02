import { describe, expect, it } from 'vitest';
import { islandOrbBobs, islandOrbState } from './islandOrbState';

const base = { working: false, replaying: false, recentlyFinished: false, finished: false };

describe('islandOrbState', () => {
  it('names each collapsed-capsule state so a change of state can restart the float', () => {
    expect(islandOrbState(base)).toBe('ready');
    expect(islandOrbState({ ...base, finished: true })).toBe('idle');
    expect(islandOrbState({ ...base, finished: true, recentlyFinished: true })).toBe('finished');
    expect(islandOrbState({ ...base, working: true })).toBe('working');
    expect(islandOrbState({ ...base, replaying: true })).toBe('replaying');
  });

  it('lets replaying and working win over a finished session', () => {
    expect(islandOrbState({ ...base, working: true, finished: true, recentlyFinished: true })).toBe('working');
    expect(islandOrbState({ ...base, replaying: true, finished: true })).toBe('replaying');
  });

  it('floats only while the orb is not following an agent', () => {
    expect(islandOrbBobs('ready')).toBe(true);
    expect(islandOrbBobs('idle')).toBe(true);
    expect(islandOrbBobs('finished')).toBe(true);
    expect(islandOrbBobs('working')).toBe(false);
    expect(islandOrbBobs('replaying')).toBe(false);
  });
});
