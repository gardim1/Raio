import { withAgent } from '../../shared/ui/agentName';
import type { NodeId } from '../architecture/model/types';
import type { AgentId, StoryEvent } from '../session/model/script';

export interface EventTimelineProps {
  readonly events: readonly StoryEvent[];
  readonly agent: AgentId;
  readonly t: number;
  readonly selectedNodeId: NodeId | null;
  /** In replay every row seeks; live, only rows tied to a system do anything. */
  readonly seekable: boolean;
  readonly onSelect: (event: StoryEvent) => void;
}

/** Session events appear only once Raio reaches them (rise 6px, 450ms soft spring) — no spoilers. */
export const EventTimeline = ({ events, agent, t, selectedNodeId, seekable, onSelect }: EventTimelineProps) => (
  <ol className="timeline" aria-label="Session events">
    {events
      .filter((ev) => t >= ev.t)
      .map((ev, i) => {
        const label = withAgent(ev.label, agent);
        const actionable = seekable || Boolean(ev.nodeId);
        return (
          <li key={i} className={`timeline__item timeline__item--in${ev.nodeId && ev.nodeId === selectedNodeId ? ' timeline__item--selected' : ''}`}>
            <button type="button" disabled={!actionable} onClick={() => onSelect(ev)}>
              <i className={`timeline__dot timeline__dot--${ev.tone}`} />
              <span className="timeline__label">{label}</span>
              {ev.realTime && <span className="timeline__time">{ev.realTime}</span>}
            </button>
          </li>
        );
      })}
  </ol>
);
