/**
 * Claude plan usage: the data contract shared by the core adapter, the bridge and the UI.
 *
 * Source: the `rate_limits` object Claude Code passes to a status line command on stdin
 * (https://code.claude.com/docs/en/statusline). Only two windows are kept: `five_hour` and `seven_day`, each with
 * `used_percentage` (0-100, the share USED, not remaining) and `resets_at` (Unix seconds). The object is present only
 * for claude.ai Pro and Max subscribers and only after the session's first API response; each window may be absent on
 * its own, and Claude Code drops a window once its reset time passes. Nothing else from the payload is kept.
 *
 * A reading is what one status line run reported when Raio received it. It is not a live counter: with no Claude Code
 * session running, nothing refreshes it. Several sessions may report the same account's limits; readings from
 * different sources are never added or merged, and the account identity is not known (Raio never reads credentials).
 */

export type UsageWindowId = 'fiveHour' | 'sevenDay';

export interface UsageWindowReading {
  /** Share of the window's limit already used, as reported (0-100). Never derived from tokens, cost or context. */
  readonly usedPercentage: number;
  /** When the window resets, as reported; null when the payload had no valid reset time. */
  readonly resetsAtMs: number | null;
}

export interface ClaudeUsageSource {
  readonly kind: 'claude-statusline';
  /** Claude Code session id that produced the reading (local association only). */
  readonly sessionId: string;
  /** Raio project the status line command was configured for. */
  readonly projectId: string;
  /** Claude Code version from the payload, when present. */
  readonly claudeVersion?: string;
}

export interface ClaudeUsageSnapshot {
  readonly source: ClaudeUsageSource;
  /** When Raio received the reading. The payload carries no observation time of its own. */
  readonly receivedAtMs: number;
  /** Absent: that window was not in the payload (not 0%). */
  readonly fiveHour?: UsageWindowReading;
  readonly sevenDay?: UsageWindowReading;
}

/** Why there is no reading to show. Each is a distinct state; none of them is "0% used". */
export type ClaudeUsageState =
  /** The connected project did not opt in (or no project is connected). */
  | { readonly status: 'disabled' }
  /** Opted out because an existing status line, managed settings or the installed version prevents it. */
  | { readonly status: 'incompatible'; readonly reason: string }
  /** Enabled; no status line run has reported limits yet (e.g. before the first response, or a plan without them). */
  | { readonly status: 'waiting' }
  /** The core could not read or validate the stored readings. */
  | { readonly status: 'error'; readonly reason: string }
  /** The most recent valid reading, from one source; `sourceCount` says how many sources reported recently. */
  | { readonly status: 'reading'; readonly latest: ClaudeUsageSnapshot; readonly sourceCount: number };

/** A reading older than this is shown as stale (it is not a live counter). */
export const USAGE_STALE_AFTER_MS = 15 * 60_000;

export type UsageWindowView =
  | { readonly kind: 'value'; readonly usedPercentage: number; readonly resetsAtMs: number | null; readonly stale: boolean }
  /** The reported reset time has passed: the old percentage no longer describes the window; wait for a new reading. */
  | { readonly kind: 'expired'; readonly resetsAtMs: number }
  /** The window was not in the latest reading. */
  | { readonly kind: 'missing' };

/** What a ring should show for one window at `nowMs`. Pure; never invents a value. */
export const usageWindowView = (snapshot: ClaudeUsageSnapshot, id: UsageWindowId, nowMs: number): UsageWindowView => {
  const reading = snapshot[id];
  if (!reading) return { kind: 'missing' };
  if (reading.resetsAtMs !== null && reading.resetsAtMs <= nowMs) return { kind: 'expired', resetsAtMs: reading.resetsAtMs };
  return { kind: 'value', usedPercentage: reading.usedPercentage, resetsAtMs: reading.resetsAtMs, stale: nowMs - snapshot.receivedAtMs > USAGE_STALE_AFTER_MS };
};
