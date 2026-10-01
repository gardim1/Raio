import type { CheckVerdict } from '../../features/session/model/script';

export interface SessionSummaryProps {
  readonly systems: number;
  readonly reviewCount: number;
  /** What may be claimed about checks; "Everything validated" requires observed passes. */
  readonly checks: CheckVerdict;
  readonly visible: boolean;
  readonly detailVisible: boolean;
}

/** "4 systems affected / 1 change worth reviewing" — the completion headline. */
const CLEAR_DETAIL: Record<CheckVerdict, string> = {
  'all-passed': 'Everything validated',
  'some-failed': 'Checks failed',
  unverified: 'Checks not confirmed',
  'none-ran': 'No checks ran',
};

export const SessionSummary = ({ systems, reviewCount, checks, visible, detailVisible }: SessionSummaryProps) => (
  <div className={`summary${visible ? ' summary--show' : ''}`}>
    <div className="summary__title">
      {systems} {systems === 1 ? 'system' : 'systems'} affected
    </div>
    <div className={`summary__detail${detailVisible ? ' summary__detail--show' : ''}${reviewCount === 0 ? (checks === 'all-passed' ? ' summary__detail--clear' : ' summary__detail--muted') : ''}`}>
      <i />
      {reviewCount === 0 ? CLEAR_DETAIL[checks] : `${reviewCount} ${reviewCount === 1 ? 'change' : 'changes'} worth reviewing`}
    </div>
  </div>
);
