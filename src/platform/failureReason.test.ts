import { expect, it } from 'vitest';
import { failureReason } from './failureReason';

it('shows the useful error sentence while replacing paths and bounding the message', () => {
  expect(failureReason(new Error('Access denied while reviewing C:/Users/private/project.')))
    .toBe('Access denied while reviewing [folder].');
  expect(failureReason(`Failure: ${'x'.repeat(300)}`)?.length).toBeLessThanOrEqual(240);
  expect(failureReason({ message: 'private object' })).toBeUndefined();
});
