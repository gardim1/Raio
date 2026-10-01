import type { ReactNode } from 'react';
import { SessionSummary } from '../../shared/ui/SessionSummary';
import { ValidationPill } from '../../shared/ui/ValidationPill';
import type { FrameState } from '../session/model/evaluateFrame';
import type { ChoreographyScript } from '../session/model/script';
import { AGENT_LABEL } from '../session/model/events';

export interface PanelFooterProps {
  readonly script: ChoreographyScript;
  readonly frame: FrameState;
  /** Centre slot (replay controls). */
  readonly center?: ReactNode;
  /** Trailing slot after the validation chips ("View changes"). */
  readonly trailing?: ReactNode;
  /** Replaces "Following Claude Code" (e.g. "Replaying session"). */
  readonly followingLabel?: string;
}

/** 68px footer: hint ↔ summary on the left, validation chips on the right. */
export const PanelFooter = ({ script, frame, center, trailing, followingLabel }: PanelFooterProps) => {
  const { ui } = frame;
  const shown = new Map(ui.validations.map((v) => [v.kind, v]));
  return (
    <div className="footer">
      <div className="footer__left">
        <div className={`hint${ui.hint === 'following' ? ' hint--on' : ''}${ui.hint === 'hidden' ? ' hint--hide' : ''}`}>
          <span className="hint__live" />
          {ui.hint === 'waiting' ? 'Waiting for an agent' : (followingLabel ?? `Following ${AGENT_LABEL[script.agent]} Code`)}
        </div>
        <SessionSummary systems={script.summary.systems} reviewCount={script.summary.reviewCount} visible={ui.summaryVisible} detailVisible={ui.summaryDetailVisible} />
      </div>
      {center && <div className="footer__center">{center}</div>}
      <div className="footer__right">
        {script.validations.map((v) => {
          const visible = shown.get(v.kind);
          return <ValidationPill key={v.kind} kind={v.kind} status={v.status} visible={Boolean(visible)} />;
        })}
        {trailing}
      </div>
    </div>
  );
};
