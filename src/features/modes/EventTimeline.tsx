import type { NodeId } from '../architecture/model/types';
import type { StoryEvent } from '../session/model/script';

export interface EventTimelineProps {
  readonly events: readonly StoryEvent[];
  readonly t: number;
  readonly selectedNodeId: NodeId | null;
  readonly onSelect: (event: StoryEvent) => void;
}

/** Session events appear only once Raio reaches them (rise 6px, 450ms soft spring) — no spoilers. */
export const EventTimeline = ({ events, t, selectedNodeId, onSelect }: EventTimelineProps) => (
  <ol className="timeline" aria-label="Session events">
    {events
      .filter((ev) => t >= ev.t)
      .map((ev, i) => (
        <li key={i} className={`timeline__item timeline__item--in${ev.nodeId && ev.nodeId === selectedNodeId ? ' timeline__item--selected' : ''}`}>
          <button type="button" onClick={() => onSelect(ev)}>
            <i className={`timeline__dot timeline__dot--${ev.tone}`} />
            <span className="timeline__label">{ev.label}</span>
            {ev.realTime && <span className="timeline__time">{ev.realTime}</span>}
          </button>
        </li>
      ))}
  </ol>
);
