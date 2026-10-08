import { describe, expect, it } from 'vitest';
import { usageWindowView, USAGE_STALE_AFTER_MS, type ClaudeUsageSnapshot } from './claudeUsage';

const snapshot = (over: Partial<ClaudeUsageSnapshot> = {}): ClaudeUsageSnapshot => ({
  source: { kind: 'claude-statusline', sessionId: 's1', projectId: 'p1' },
  receivedAtMs: 1_000_000,
  fiveHour: { usedPercentage: 32, resetsAtMs: 2_000_000 },
  ...over,
});

describe('usageWindowView', () => {
  it('a missing window is missing, never 0%', () => {
    expect(usageWindowView(snapshot(), 'sevenDay', 1_000_001)).toEqual({ kind: 'missing' });
  });
  it('a real 0% stays a value', () => {
    expect(usageWindowView(snapshot({ fiveHour: { usedPercentage: 0, resetsAtMs: null } }), 'fiveHour', 1_000_001)).toMatchObject({ kind: 'value', usedPercentage: 0 });
  });
  it('a passed reset expires the old percentage instead of assuming it went to zero', () => {
    expect(usageWindowView(snapshot(), 'fiveHour', 2_000_000)).toEqual({ kind: 'expired', resetsAtMs: 2_000_000 });
  });
  it('an old reading is stale, a recent one is not', () => {
    expect(usageWindowView(snapshot(), 'fiveHour', 1_000_000 + USAGE_STALE_AFTER_MS)).toMatchObject({ kind: 'value', stale: false });
    expect(usageWindowView(snapshot(), 'fiveHour', 1_000_001 + USAGE_STALE_AFTER_MS)).toMatchObject({ kind: 'value', stale: true });
  });
});
