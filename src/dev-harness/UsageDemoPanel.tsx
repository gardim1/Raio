import type { ClaudeUsageState } from '../features/usage/claudeUsage';
import { UsageRings } from '../features/usage/ui/UsageRings';

export const USAGE_DEMO_NOW = Date.UTC(2026, 9, 8, 12);
const latest = {
  source: { kind: 'claude-statusline' as const, projectId: 'demo-project', sessionId: 'demo1234-simulated' },
  receivedAtMs: USAGE_DEMO_NOW - 120_000,
  fiveHour: { usedPercentage: 24, resetsAtMs: USAGE_DEMO_NOW + 3600_000 },
  sevenDay: { usedPercentage: 68, resetsAtMs: USAGE_DEMO_NOW + 3 * 86400_000 },
};
export const USAGE_DEMO_STATES: readonly { id: string; label: string; state: ClaudeUsageState }[] = [
  { id: 'fresh', label: 'Fresh · two sources', state: { status: 'reading', latest, sourceCount: 2 } },
  { id: 'stale', label: 'Stale', state: { status: 'reading', latest: { ...latest, receivedAtMs: USAGE_DEMO_NOW - 18 * 60_000 }, sourceCount: 1 } },
  { id: 'missing', label: '5-hour window missing', state: { status: 'reading', latest: { ...latest, fiveHour: undefined }, sourceCount: 1 } },
  { id: 'expired', label: 'Weekly window expired', state: { status: 'reading', latest: { ...latest, sevenDay: { ...latest.sevenDay, resetsAtMs: USAGE_DEMO_NOW - 1 } }, sourceCount: 1 } },
  { id: 'waiting', label: 'Waiting', state: { status: 'waiting' } },
  { id: 'incompatible', label: 'Incompatible', state: { status: 'incompatible', reason: 'DEMO · an existing user status line has not been replaced in this project.' } },
  { id: 'error', label: 'Read error', state: { status: 'error', reason: 'DEMO · the local usage snapshot could not be read.' } },
  { id: 'disabled', label: 'Disabled', state: { status: 'disabled' } },
];
/** Explicit fixtures, never imported into the product. */
export const UsageDemoPanel = () => <section className="usage-demo" aria-label="DEMO Claude plan usage">
  <h2>Claude plan usage · DEMO</h2>
  <p>Simulated limits, sources and reset times. These are not your account readings. Inner ring: 5-hour limit. Outer ring: weekly limit. Fill shows the share used.</p>
  <div className="usage-demo__grid">
    {USAGE_DEMO_STATES.map(({ id, label, state }) => <article className="usage-demo__state" data-usage-demo={id} key={id}>
      <h3>DEMO · {label}</h3><UsageRings state={state} compact nowMs={USAGE_DEMO_NOW} />
    </article>)}
  </div>
</section>;
