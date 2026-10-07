import type { JSX } from 'react';
import type { ValidationKind, ValidationStatus } from '../../features/session/model/script';
import { CheckIcon, CrossIcon, SpinnerIcon } from './icons';
import { unknownResultText } from '../../features/session/model/unknownResultText';

const KIND_LABEL: Record<ValidationKind, string> = { build: 'Build', tests: 'Tests' };
/** Neutral mark for checks whose outcome Raio did not observe. */
const UnknownIcon = () => (
  <svg className="icon-unknown" width="12" height="12" viewBox="0 0 12 12" aria-hidden>
    <path d="M3 6h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

const ICON: Record<ValidationStatus, () => JSX.Element> = {
  running: SpinnerIcon,
  passed: CheckIcon,
  failed: CrossIcon,
  unknown: UnknownIcon,
  incomplete: UnknownIcon,
  stale: UnknownIcon,
};
const STATUS_TEXT: Record<ValidationStatus, string> = {
  running: 'running',
  passed: 'passed',
  failed: 'failed',
  unknown: 'result unknown',
  incomplete: 'incomplete',
  stale: 'stale',
};

export interface ValidationPillProps {
  readonly kind: ValidationKind;
  readonly status: ValidationStatus;
  readonly detail?: string;
  /** Toggling `visible` plays the enter/exit transition (700ms bouncy spring). */
  readonly visible?: boolean;
}

/** Compact build/test result chip. Passed = mint, running = cool, failed = coral, unknown/incomplete = muted. */
export const ValidationPill = ({ kind, status, detail, visible = true }: ValidationPillProps) => {
  const Icon = ICON[status];
  return (
    <div className={`chip chip--${status}${visible ? ' chip--show' : ''}`} aria-hidden={!visible}>
      <Icon />
      {KIND_LABEL[kind]} {status === 'unknown' ? unknownResultText(detail) : STATUS_TEXT[status]}
    </div>
  );
};
