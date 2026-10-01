import type { RiskKind } from '../../features/session/model/script';
import { RISK_LABEL } from '../../features/session/model/events';

export interface RiskPillProps {
  readonly kind: RiskKind;
  readonly label?: string;
  readonly tone?: 'warning' | 'danger';
}

/** HTML version of the contextual risk pill (Island, inspector, timeline, gallery). */
export const RiskPill = ({ kind, label, tone = 'warning' }: RiskPillProps) => (
  <span className={`risk-pill risk-pill--${tone}`}>
    <i />
    {label ?? RISK_LABEL[kind]}
  </span>
);
