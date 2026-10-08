import { useBridge } from '../../../platform/BridgeContext';
import { useSurfaceStore } from '../../../shared/motion/visibleStore';
import type { ClaudeUsageState } from '../claudeUsage';

interface UsageReader { claudeUsage?(): ClaudeUsageState }
const disabled: ClaudeUsageState = { status: 'disabled' };
/** Optional until the native reader is integrated; an absent getter is never DEMO data. */
export const readClaudeUsage = (bridge: UsageReader): ClaudeUsageState => bridge.claudeUsage?.() ?? disabled;
export const useClaudeUsage = (): ClaudeUsageState => {
  const bridge = useBridge();
  return useSurfaceStore(bridge.subscribe, () => readClaudeUsage(bridge as typeof bridge & UsageReader));
};
