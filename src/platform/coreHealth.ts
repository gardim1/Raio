import type { CoreHealth } from './desktopBridge';

/** Shared wording for a pipeline that cannot receive new hook events. */
export const HOOK_BINARY_MISSING_NOTE = 'raio-hook was not found next to Raio; new agent events cannot be recorded.';
export const CORE_STATUS_UNAVAILABLE_NOTE = 'Core status unavailable; new agent events cannot be confirmed.';

export const receptionProblem = (core: CoreHealth | null | undefined, fixture: boolean): string | null => {
  if (core === null || (!core && !fixture)) return CORE_STATUS_UNAVAILABLE_NOTE;
  if (core && !core.hookBinary) return HOOK_BINARY_MISSING_NOTE;
  return null;
};
