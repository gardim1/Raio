import { describe, expect, it } from 'vitest';
import * as playback from './usePlayback';
describe('playback reconciliation after hidden time', () => {
  it('jumps live wall time to the stopped current view, but keeps replay position', () => {
    expect(playback.resumePlaybackTime(5, 1000, 61000, { wallClock: true, speed: 1, stopAt: 40 })).toBe(40);
    expect(playback.resumePlaybackTime(5, 1000, 61000, { wallClock: false, speed: 1, stopAt: 40 })).toBe(5);
  });
  it('preserves speed and an unstarted clock without inventing hidden activity', () => {
    expect(playback.resumePlaybackTime(5, 1000, 2000, { wallClock: true, speed: 2 })).toBe(7);
    expect(playback.resumePlaybackTime(5, null, 2000, { wallClock: true, speed: 1 })).toBe(5);
  });
});
