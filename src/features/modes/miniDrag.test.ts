import { expect, it } from 'vitest';
import { canStartMiniDrag } from './miniDrag';
const target = (hit: string | null) => ({ closest: (selector: string) => hit && selector.split(',').includes(hit) ? {} : null });
it('allows a primary press on empty Mini header but never on its mascot or controls', () => {
  expect(canStartMiniDrag(target(null), 0)).toBe(true);
  for (const hit of ['button', '.mini__status', '.mini-orb']) expect(canStartMiniDrag(target(hit), 0)).toBe(false);
  expect(canStartMiniDrag(target(null), 2)).toBe(false);
});
