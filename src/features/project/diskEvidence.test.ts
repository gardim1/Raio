import { describe, expect, it } from 'vitest';
import { assessReportedEdits, DISK_WINDOW_MS, findUnassignedChanges, firstChangeAfter, type PathMoment } from './diskEvidence';

const at = (path: string, seconds: number): PathMoment => ({ path, at: seconds * 1000 });

describe('assessReportedEdits', () => {
  it('uses a 5 second window', () => {
    expect(DISK_WINDOW_MS).toBe(5000);
  });

  it('keeps an edit without a matching disk change as reported only', () => {
    const [a] = assessReportedEdits([at('src/a.ts', 10)], []);
    expect(a).toMatchObject({ disk: 'not-observed', confidence: 'medium', concurrentChange: false });
  });

  it('marks an edit consistent when the same path changes within the window after it', () => {
    const [a] = assessReportedEdits([at('src/a.ts', 10)], [at('src/a.ts', 12)]);
    expect(a).toMatchObject({ disk: 'consistent', confidence: 'high', concurrentChange: false });
  });

  it('marks an edit consistent when the change was observed before the (late async) report', () => {
    const [a] = assessReportedEdits([at('src/a.ts', 10)], [at('src/a.ts', 6)]);
    expect(a?.disk).toBe('consistent');
  });

  it('includes both ends of the window and excludes anything beyond it', () => {
    expect(assessReportedEdits([at('a', 10)], [at('a', 15)])[0]?.disk).toBe('consistent');
    expect(assessReportedEdits([at('a', 10)], [at('a', 5)])[0]?.disk).toBe('consistent');
    expect(assessReportedEdits([at('a', 10)], [at('a', 15.001)])[0]?.disk).toBe('not-observed');
  });

  it('does not match a change to a different path', () => {
    expect(assessReportedEdits([at('src/a.ts', 10)], [at('src/b.ts', 10)])[0]?.disk).toBe('not-observed');
  });

  it('lowers confidence when more disk changes happened than the agent reported (a concurrent human edit)', () => {
    const [a] = assessReportedEdits([at('src/a.ts', 10)], [at('src/a.ts', 10.4), at('src/a.ts', 13)]);
    expect(a).toMatchObject({ disk: 'consistent', concurrentChange: true });
    expect(a?.confidence).toBe('low');
  });

  it('does not call two agent edits plus two changes a concurrent change', () => {
    const edits = [at('src/a.ts', 10), at('src/a.ts', 12)];
    const out = assessReportedEdits(edits, [at('src/a.ts', 10.3), at('src/a.ts', 12.2)]);
    expect(out.map((e) => e.concurrentChange)).toEqual([false, false]);
    expect(out.map((e) => e.confidence)).toEqual(['high', 'high']);
  });

  it('keeps one result per edit in input order', () => {
    const out = assessReportedEdits([at('b', 1), at('a', 2)], []);
    expect(out.map((e) => e.path)).toEqual(['b', 'a']);
  });
});

describe('findUnassignedChanges', () => {
  it('returns changes with no reported edit for the same path within the window', () => {
    const changes = [at('src/a.ts', 10), at('README.md', 11)];
    expect(findUnassignedChanges(changes, [at('src/a.ts', 9)])).toEqual([at('README.md', 11)]);
  });

  it('treats a change just outside the window as unassigned', () => {
    expect(findUnassignedChanges([at('a', 20)], [at('a', 10)])).toEqual([at('a', 20)]);
  });

  it('keeps an extra change on a reported path unassigned when the agent reported fewer edits than changes', () => {
    const out = findUnassignedChanges([at('a', 10.2), at('a', 13)], [at('a', 10)]);
    expect(out).toEqual([at('a', 13)]);
  });

  it('is empty without changes', () => {
    expect(findUnassignedChanges([], [at('a', 1)])).toEqual([]);
  });
});

describe('firstChangeAfter', () => {
  it('returns the first project change after the result time', () => {
    expect(firstChangeAfter(10_000, [at('a', 5), at('b', 14), at('c', 20)], [])).toBe(14_000);
  });

  it('returns undefined when nothing changed afterwards', () => {
    expect(firstChangeAfter(10_000, [at('a', 5), at('a', 10)], [])).toBeUndefined();
  });

  it('ignores the late echo of an edit the agent reported before the result', () => {
    // Edit at 9 s, result at 10 s, the watcher reports the same write at 11 s.
    expect(firstChangeAfter(10_000, [at('src/a.ts', 11)], [at('src/a.ts', 9)])).toBeUndefined();
  });

  it('counts a change that does not echo an earlier reported edit', () => {
    expect(firstChangeAfter(10_000, [at('src/a.ts', 11)], [at('src/other.ts', 9)])).toBe(11_000);
  });

  it('counts an agent-reported edit made after the result even without a watcher event', () => {
    expect(firstChangeAfter(10_000, [], [at('src/a.ts', 12)])).toBe(12_000);
  });

  it('ignores paths outside the project', () => {
    expect(firstChangeAfter(10_000, [at('outside-project', 12)], [at('outside-project', 13)])).toBeUndefined();
  });
});
