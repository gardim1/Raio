import { describe, expect, it, vi } from 'vitest';
import { runLiveLoop } from './liveLoop';
import { compileReplay } from '../model/compileReplay';
import { demoGraph } from '../../architecture/model/demoProject';
import { demoSessionLog } from '../model/demoSession';
import { startLive } from './liveDirector';
describe('live graphic loop visibility', () => {
  it('never schedules or paints a hidden surface', () => {
    const script = compileReplay(demoSessionLog, demoGraph, { live: true });
    const request = vi.fn(), paint = vi.fn();
    runLiveLoop({ read: () => startLive(script, 0), write: vi.fn(), ctx: { visible: false, reducedMotion: false }, schedule: { request, cancel: vi.fn() }, paint });
    expect(request).not.toHaveBeenCalled(); expect(paint).not.toHaveBeenCalled();
  });
  it('a callback already dequeued before cleanup cannot paint or reschedule after disposal', () => {
    const script = compileReplay(demoSessionLog, demoGraph, { live: true });
    let callback: ((now: number) => void) | undefined;
    const paint = vi.fn(), cancel = vi.fn();
    const request = vi.fn((cb: (now: number) => void) => { callback = cb; return 1; });
    const stop = runLiveLoop({ read: () => startLive(script, 0), write: vi.fn(), ctx: { visible: true, reducedMotion: false }, schedule: { request, cancel }, paint });
    stop(); callback!(16);
    expect(cancel).toHaveBeenCalledWith(1); expect(paint).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledTimes(1);
  });
});
