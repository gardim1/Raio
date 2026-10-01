import type { ReactNode } from 'react';
import { agentFullName } from '../../shared/ui/agentName';
import { SessionSummary } from '../../shared/ui/SessionSummary';
import { ValidationPill } from '../../shared/ui/ValidationPill';
import type { FrameState } from '../session/model/evaluateFrame';
import type { ChoreographyScript, ValidationCue } from '../session/model/script';

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

/** One cue per kind: the newest (a "running" chip swaps in place to its result) or, for hidden chips, the first to appear. */
const pickByKind = (cues: readonly ValidationCue[], pick: 'newest' | 'first'): Map<ValidationCue['kind'], ValidationCue> => {
  const picked = new Map<ValidationCue['kind'], ValidationCue>();
  for (const cue of cues) {
    const current = picked.get(cue.kind);
    if (!current || (pick === 'newest' ? cue.at >= current.at : cue.at < current.at)) picked.set(cue.kind, cue);
  }
  return picked;
};

/** 68px footer: hint ↔ summary on the left, replay controls centred, validation chips on the right. */
export const PanelFooter = ({ script, frame, center, trailing, followingLabel }: PanelFooterProps) => {
  const { ui } = frame;
  const shown = pickByKind(ui.validations, 'newest');
  const kinds = [...new Set(script.validations.map((v) => v.kind))];
  const upcoming = pickByKind(script.validations, 'first');
  return (
    <div className="footer">
      <div className="footer__left">
        <div className={`hint${ui.hint === 'following' ? ' hint--on' : ''}${ui.hint === 'hidden' ? ' hint--hide' : ''}`}>
          <span className="hint__live" />
          {ui.hint === 'waiting' ? 'Waiting for an agent' : (followingLabel ?? `Following ${agentFullName(script.agent)}`)}
        </div>
        <SessionSummary systems={script.summary.systems} reviewCount={script.summary.reviewCount} checks={script.summary.checks} visible={ui.summaryVisible} detailVisible={ui.summaryDetailVisible} />
      </div>
      {center && <div className="footer__center">{center}</div>}
      <div className="footer__right">
        {kinds.map((kind) => {
          const current = shown.get(kind);
          const cue = current ?? upcoming.get(kind);
          return cue ? <ValidationPill key={kind} kind={kind} status={cue.status} visible={Boolean(current)} /> : null;
        })}
        {trailing}
      </div>
    </div>
  );
};
