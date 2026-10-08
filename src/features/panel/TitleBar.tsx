import type { MouseEvent, ReactNode } from 'react';
import { AgentStatus } from '../../shared/ui/AgentStatus';
import { agentFullName } from '../../shared/ui/agentName';
import { MiniOrb } from '../raio/MiniOrb';
import type { AgentId, AgentStatusState } from '../session/model/script';
import type { CompanionPresence } from '../modes/companionPresence';
import { WindowCaption } from './WindowCaption';

/** Only supplied for Expanded's undecorated native window; injectable without a Tauri runtime. */
export interface TitleBarWindowApi {
  close(): Promise<void>;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  startDragging(): Promise<void>;
  isMaximized(): Promise<boolean>;
  onResized(callback: () => void): Promise<() => void>;
}

export const runWindowAction = async (action: () => Promise<void>) => {
  try {
    await action();
  } catch (error) {
    console.warn('Raio window action failed', error);
  }
};

const dragTitlebar = (window: TitleBarWindowApi, event: MouseEvent<HTMLDivElement>) => {
  const target = event.target as Element;
  if (event.button !== 0 || event.buttons !== 1 || target.closest('button,a,input,textarea,select,[role="button"],[contenteditable]:not([contenteditable="false"]),.titlebar__task,.mini-orb')) return;
  event.preventDefault();
  // Use the second mousedown: the OS drag loop may consume the later DOM dblclick event.
  return runWindowAction(() => event.detail === 2 ? window.toggleMaximize() : window.startDragging());
};

export interface TitleBarProps {
  readonly companion?: CompanionPresence;
  readonly project: string;
  readonly agent: AgentId;
  readonly task: string;
  readonly taskVisible: boolean;
  readonly status: AgentStatusState;
  readonly statusLabel?: string;
  /** Show decorative dots, or Windows caption controls when nativeWindow is supplied. */
  readonly windowDots?: boolean;
  readonly nativeWindow?: TitleBarWindowApi;
  readonly actions?: ReactNode;
  /** Replaces "Claude Code is working on" (e.g. "Replay of"). */
  readonly taskPrefix?: string;
  /** The task is a generated label: show it plainly, not as a quoted request. */
  readonly taskIsPlaceholder?: boolean;
}

/** One 54px bar: decorative dots in the harness; right-hand captions for native Windows Expanded. */
export const TitleBar = ({ project, agent, task, taskVisible, status, statusLabel, windowDots = true, nativeWindow, actions, taskPrefix, taskIsPlaceholder = false, companion }: TitleBarProps) => (
  <div className={`titlebar${nativeWindow ? ' titlebar--native' : ''}`} onMouseDown={nativeWindow ? (event) => dragTitlebar(nativeWindow, event) : undefined}>
    {windowDots && !nativeWindow && (
      <div className="titlebar__dots" aria-hidden>
        <i />
        <i />
        <i />
      </div>
    )}
    <div className="titlebar__brand">
      <MiniOrb size={12} companion={companion} />
      Raio
    </div>
    <span className="titlebar__sep" />
    <span className="titlebar__project">{project}</span>
    <div className={`titlebar__task${taskVisible ? ' titlebar__task--show' : ''}`}>
      {taskIsPlaceholder ? (
        <>
          {taskPrefix ? `${taskPrefix} ` : `${agentFullName(agent)} · `}
          <b>{task}</b>
        </>
      ) : (
        <>
          {taskPrefix ?? `${agentFullName(agent)} is working on`} <b>“{task}”</b>
        </>
      )}
    </div>
    <div className="titlebar__end">
      <AgentStatus state={status} agent={agent} companion={companion} {...(statusLabel ? { label: statusLabel } : {})} />
      {actions && <div className="titlebar__actions">{actions}</div>}
    </div>
    {windowDots && nativeWindow && <WindowCaption nativeWindow={nativeWindow} />}
  </div>
);
