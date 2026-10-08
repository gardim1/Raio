import { UsageRings } from '../usage/ui/UsageRings';
import { useClaudeUsage } from '../usage/ui/useClaudeUsage';
import { useUsageNow } from '../usage/ui/usageClock';
import { usagePercentage } from '../usage/ui/UsageDetails';
import { usageWindowView, type ClaudeUsageState } from '../usage/claudeUsage';

export const islandUsageSummary = (state: ClaudeUsageState, now: number): string => {
  if (state.status !== 'reading') return 'Usage unavailable';
  const five = usageWindowView(state.latest, 'fiveHour', now), week = usageWindowView(state.latest, 'sevenDay', now);
  if (five.kind !== 'value' && week.kind !== 'value') return 'Usage unavailable';
  const value = (window: typeof five) => window.kind === 'value' ? `${usagePercentage(window.usedPercentage)}%` : '—';
  return `5h ${value(five)} · week ${value(week)} used`;
};

/** Mounted only in the visible preview. One shared minute clock keeps summary and rings in agreement. */
export const IslandUsage = ({ onOpenChange }: { readonly onOpenChange?: (open:boolean) => void }) => {
  const state = useClaudeUsage();
  const now = useUsageNow(state.status === 'reading');
  if (state.status === 'disabled') return null;
  const summary = islandUsageSummary(state, now);
  return <div className="island__usage">
    <UsageRings state={state} compact nowMs={now} onOpenChange={onOpenChange} />
    {summary !== 'Usage unavailable' && <span className="island__usage-summary">{summary}</span>}
  </div>;
};
