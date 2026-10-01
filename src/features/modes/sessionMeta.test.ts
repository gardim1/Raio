import { describe, expect, it } from 'vitest';
import { formatClockTime } from './sessionMeta';

describe('formatClockTime', () => {
  it('formats an ISO timestamp as 24-hour HH:MM in the requested zone', () => {
    expect(formatClockTime('2026-10-01T14:02:00Z', 'UTC')).toBe('14:02');
    expect(formatClockTime('2026-10-01T14:02:00Z', 'America/Sao_Paulo')).toBe('11:02');
    expect(formatClockTime('2026-10-01T00:05:00Z', 'UTC')).toBe('00:05');
  });

  it('returns null when there is no usable timestamp', () => {
    expect(formatClockTime(undefined)).toBeNull();
    expect(formatClockTime('not a date')).toBeNull();
  });
});
