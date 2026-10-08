import { usageWindowView, USAGE_STALE_AFTER_MS, type ClaudeUsageState, type UsageWindowId } from '../claudeUsage';

export const usagePercentage = (value: number): string => new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(value);
const age = (milliseconds: number): string => {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes === 0) return 'less than a minute';
  const [count, unit] = minutes < 60 ? [minutes, 'minute'] : minutes < 1440 ? [Math.floor(minutes / 60), 'hour'] : [Math.floor(minutes / 1440), 'day'];
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
};
const windowLine = (state: Extract<ClaudeUsageState, { status: 'reading' }>, id: UsageWindowId, nowMs: number): string => {
  const window = usageWindowView(state.latest, id, nowMs), label = id === 'fiveHour' ? '5-hour limit' : 'Weekly limit';
  if (window.kind === 'missing') return `${label} · — · not reported`;
  if (window.kind === 'expired') return `${label} · — · reset passed; waiting for a new reading`;
  const reset = window.resetsAtMs === null ? 'reset time unavailable' : `resets ${new Intl.DateTimeFormat('en', { ...(id === 'sevenDay' ? { weekday: 'short' as const } : {}), hour: 'numeric', minute: '2-digit' }).format(window.resetsAtMs)}`;
  return `${label} · ${usagePercentage(window.usedPercentage)}% used · ${reset}`;
};
export const UsageDetails = ({ state, nowMs, id }: { readonly state: ClaudeUsageState; readonly nowMs: number; readonly id: string }) => (
  <section className="usage-details" id={id} role="region" aria-label="Claude plan usage details" tabIndex={0}>
    <strong>Claude plan usage</strong>
    {state.status === 'reading' ? <>
      <p className="usage-details__five-hour">{windowLine(state, 'fiveHour', nowMs)}</p>
      <p className="usage-details__weekly">{windowLine(state, 'sevenDay', nowMs)}</p>
      <p>Updated {age(nowMs - state.latest.receivedAtMs)} ago</p>
      {nowMs - state.latest.receivedAtMs > USAGE_STALE_AFTER_MS && <p>Stale reading · waiting for Claude Code to report again.</p>}
      {state.sourceCount > 1 && <p>Source Claude Code session {state.latest.source.sessionId.slice(0, 8)} · latest of {state.sourceCount} sources. Readings are not combined.</p>}
    </> : <p>{state.status === 'disabled' ? 'Plan usage is not enabled for this project.' : state.status === 'waiting' ? 'Waiting for Claude Code to report plan limits. A reading is available only after a response on an eligible plan.' : state.reason}</p>}
  </section>
);
