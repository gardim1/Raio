export interface SessionSummaryProps {
  readonly systems: number;
  readonly reviewCount: number;
  readonly visible: boolean;
  readonly detailVisible: boolean;
}

/** "4 systems affected / 1 change worth reviewing" — the completion headline. */
export const SessionSummary = ({ systems, reviewCount, visible, detailVisible }: SessionSummaryProps) => (
  <div className={`summary${visible ? ' summary--show' : ''}`}>
    <div className="summary__title">
      {systems} {systems === 1 ? 'system' : 'systems'} affected
    </div>
    <div className={`summary__detail${detailVisible ? ' summary__detail--show' : ''}${reviewCount === 0 ? ' summary__detail--clear' : ''}`}>
      <i />
      {reviewCount === 0 ? 'Everything validated' : `${reviewCount} ${reviewCount === 1 ? 'change' : 'changes'} worth reviewing`}
    </div>
  </div>
);
