import type { JSX } from 'react';
import type { ValidationKind, ValidationStatus } from '../../features/session/model/script';
import { CheckIcon, CrossIcon, SpinnerIcon } from './icons';

const KIND_LABEL: Record<ValidationKind, string> = { build: 'Build', tests: 'Tests' };
const ICON: Record<ValidationStatus, () => JSX.Element> = { running: SpinnerIcon, passed: CheckIcon, failed: CrossIcon };

export interface ValidationPillProps {
  readonly kind: ValidationKind;
  readonly status: ValidationStatus;
  /** Toggling `visible` plays the enter/exit transition (700ms bouncy spring). */
  readonly visible?: boolean;
}

/** Compact build/test result chip. Passed = mint, running = cool, failed = coral. */
export const ValidationPill = ({ kind, status, visible = true }: ValidationPillProps) => {
  const Icon = ICON[status];
  return (
    <div className={`chip chip--${status}${visible ? ' chip--show' : ''}`} aria-hidden={!visible}>
      <Icon />
      {KIND_LABEL[kind]} {status}
    </div>
  );
};
