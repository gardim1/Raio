import { useLayoutEffect, useRef, useState } from 'react';
import { AGENT_LABEL } from '../../features/session/model/events';
import type { AgentId, AgentStatusState } from '../../features/session/model/script';

export const statusLabel = (state: AgentStatusState, agent: AgentId): string => {
  switch (state) {
    case 'ready':
      return 'Ready';
    case 'working':
      return `${AGENT_LABEL[agent]} working`;
    case 'complete':
      return 'Complete';
    case 'finished':
      return `${AGENT_LABEL[agent]} finished`;
    case 'failed':
      return 'Needs attention';
  }
};

export interface AgentStatusProps {
  readonly state: AgentStatusState;
  readonly agent: AgentId;
  /** Overrides the default label (e.g. "Replay"). */
  readonly label?: string;
}

/**
 * The status pill. Width springs to fit the new label (550ms, cubic-bezier(.3,1.25,.4,1));
 * the label swaps with a 6px rise + 3px blur (450ms).
 */
export const AgentStatus = ({ state, agent, label }: AgentStatusProps) => {
  const text = label ?? statusLabel(state, agent);
  const measure = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number>();
  useLayoutEffect(() => {
    const update = () => setWidth(measure.current?.offsetWidth);
    update();
    // Re-measure once web fonts are ready; measuring with the fallback font clips the label.
    let alive = true;
    void document.fonts?.ready.then(() => alive && update());
    return () => {
      alive = false;
    };
  }, [text]);
  return (
    <div className={`status status--${state}`} role="status" aria-live="polite">
      <span className="status__dot" />
      <span className="status__label-wrap" style={width ? { width } : undefined}>
        <span key={text} className="status__label">
          {text}
        </span>
      </span>
      <span ref={measure} className="status__measure" aria-hidden>
        {text}
      </span>
    </div>
  );
};
