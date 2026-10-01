import type { ReactNode } from 'react';
import { AgentStatus } from '../../shared/ui/AgentStatus';
import { agentFullName } from '../../shared/ui/agentName';
import { MiniOrb } from '../raio/MiniOrb';
import type { AgentId, AgentStatusState } from '../session/model/script';

export interface TitleBarProps {
  readonly project: string;
  readonly agent: AgentId;
  readonly task: string;
  readonly taskVisible: boolean;
  readonly status: AgentStatusState;
  readonly statusLabel?: string;
  /** Show the three muted window dots (desktop window chrome). */
  readonly windowDots?: boolean;
  readonly actions?: ReactNode;
  /** Replaces "Claude Code is working on" (e.g. "Replay of"). */
  readonly taskPrefix?: string;
}

/** 54px title bar: dots · brand · project | centred task | status pill (+ actions). */
export const TitleBar = ({ project, agent, task, taskVisible, status, statusLabel, windowDots = true, actions, taskPrefix }: TitleBarProps) => (
  <div className="titlebar">
    {windowDots && (
      <div className="titlebar__dots" aria-hidden>
        <i />
        <i />
        <i />
      </div>
    )}
    <div className="titlebar__brand">
      <MiniOrb size={12} />
      Raio
    </div>
    <span className="titlebar__sep" />
    <span className="titlebar__project">{project}</span>
    <div className={`titlebar__task${taskVisible ? ' titlebar__task--show' : ''}`}>
      {taskPrefix ?? `${agentFullName(agent)} is working on`} <b>“{task}”</b>
    </div>
    <div className="titlebar__end">
      <AgentStatus state={status} agent={agent} {...(statusLabel ? { label: statusLabel } : {})} />
      {actions && <div className="titlebar__actions">{actions}</div>}
    </div>
  </div>
);
