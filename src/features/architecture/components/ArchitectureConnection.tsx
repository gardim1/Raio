import { mixRgb, rgba } from '../../../shared/color';
import { palette, toneRgb } from '../../../tokens';
import type { EdgeFrame } from '../../session/model/evaluateFrame';
import type { ArchitectureEdge } from '../model/types';

export interface ArchitectureConnectionProps {
  readonly edge: ArchitectureEdge;
  readonly frame: EdgeFrame;
  readonly idPrefix: string;
}

/**
 * A relationship line. Untouched relationships are dotted hairlines; relationships on the
 * session path stay hidden until they draw themselves from caller to callee.
 */
export const ArchitectureConnection = ({ edge, frame, idPrefix }: ArchitectureConnectionProps) => {
  const d = edge.path.toSvg();
  if (!frame.revealed) {
    return <path d={d} fill="none" stroke="rgba(255,255,255,.09)" strokeWidth={1.2} strokeDasharray="2 5" strokeLinecap="round" opacity={frame.opacity} />;
  }
  const len = edge.path.length;
  const offset = len * (1 - frame.draw);
  const gradientId = `${idPrefix}-edge-${edge.id}`;
  const end = mixRgb(palette.cool, toneRgb(frame.endTone), frame.endToneAmount);
  return (
    <g>
      <defs>
        <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1={edge.path.start.x} y1={edge.path.start.y} x2={edge.path.end.x} y2={edge.path.end.y}>
          <stop offset="0" stopColor={rgba(palette.cool, 1)} />
          <stop offset="1" stopColor={rgba(end, 1)} />
        </linearGradient>
      </defs>
      <path
        d={d}
        fill="none"
        stroke={`url(#${gradientId})`}
        strokeWidth={7}
        strokeLinecap="round"
        filter={`url(#${idPrefix}-blur3)`}
        strokeDasharray={len}
        strokeDashoffset={offset}
        opacity={frame.glowOpacity}
      />
      <path d={d} fill="none" stroke={`url(#${gradientId})`} strokeWidth={frame.width} strokeLinecap="round" strokeDasharray={len} strokeDashoffset={offset} opacity={frame.opacity} />
    </g>
  );
};
