import { mixRgb, rgba } from '../../../shared/color';
import { lerp } from '../../../shared/motion/easing';
import { palette, toneRgb } from '../../../tokens';
import type { NodeFrame, RiskFrame } from '../../session/model/evaluateFrame';
import type { ArchitectureNode as NodeModel } from '../model/types';
import { NODE_SIZE } from '../model/graph';

const W = NODE_SIZE.width;
const H = NODE_SIZE.height;

export type NodeVariant = 'full' | 'mini';

export interface ArchitectureNodeProps {
  readonly node: NodeModel;
  readonly frame: NodeFrame;
  readonly t: number;
  readonly variant: NodeVariant;
  readonly idPrefix: string;
  readonly risk?: RiskFrame;
  readonly selected?: boolean;
  readonly onSelect?: (id: string) => void;
  readonly onHover?: (id: string | null, element: SVGGElement | null) => void;
}

/**
 * A system on the map: a 132×52 squircle-ish rounded rect with a status dot, label and
 * detail line. Dormant → active is a blend from neutral glass to the tone colour.
 */
export const ArchitectureNode = ({ node, frame, t, variant, idPrefix, risk, selected = false, onSelect, onHover }: ArchitectureNodeProps) => {
  const a = frame.activation;
  const col = mixRgb(palette.cool, toneRgb(frame.tone), frame.toneAmount);
  const bc = mixRgb(palette.neutral, col, a);
  const x = node.position.x + frame.offset.x;
  const y = node.position.y + frame.offset.y;
  const scale = 1 + 0.07 * frame.bounce;
  const mini = variant === 'mini';
  const interactive = Boolean(onSelect);

  return (
    <g
      className={`arch-node${interactive ? ' arch-node--interactive' : ''}`}
      transform={`translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${scale.toFixed(4)})`}
      opacity={frame.opacity}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={`${node.label}${frame.detail && a > 0 ? `, ${frame.detail}` : ''}`}
      onClick={interactive ? () => onSelect?.(node.id) : undefined}
      onKeyDown={interactive ? (e) => (e.key === 'Enter' || e.key === ' ') && onSelect?.(node.id) : undefined}
      onPointerEnter={onHover ? (e) => onHover(node.id, e.currentTarget) : undefined}
      onPointerLeave={onHover ? () => onHover(null, null) : undefined}
    >
      {risk?.ripples.map((r, i) => (
        <rect
          key={i}
          x={-W / 2}
          y={-H / 2}
          width={W}
          height={H}
          rx={17}
          fill="none"
          stroke={rgba(toneRgb(risk.cue.tone), 1)}
          strokeWidth={1.2}
          opacity={r.opacity}
          transform={`scale(${r.scale.toFixed(4)})`}
        />
      ))}
      <g className="arch-node__body">
        <rect
          x={-W / 2 + 6}
          y={-H / 2 + 6}
          width={W - 12}
          height={H - 12}
          rx={14}
          fill={rgba(col, 1)}
          filter={`url(#${idPrefix}-blur10)`}
          opacity={0.34 * a * (1 + 0.25 * Math.sin(t * 4) * frame.toneAmount)}
        />
        <rect x={-W / 2} y={-H / 2} width={W} height={H} rx={17} fill={rgba(bc, 0.035 + 0.075 * a)} stroke={rgba(bc, 0.09 + 0.38 * a)} strokeWidth={1} />
        {selected && <rect x={-W / 2 - 5} y={-H / 2 - 5} width={W + 10} height={H + 10} rx={21} fill="none" stroke={rgba(col, 0.55)} strokeWidth={1} />}
        {mini ? (
          <text textAnchor="middle" y={9} fontSize={26} fontWeight={600} fill="#fff" fillOpacity={0.42 + 0.58 * a} letterSpacing="-0.01em">
            {node.label}
          </text>
        ) : (
          <>
            <circle cx={-W / 2 + 20} cy={0} r={3.2 + 1.2 * frame.bounce} fill={a > 0.01 ? rgba(col, 0.4 + 0.6 * a) : 'rgba(255,255,255,.22)'} />
            <text x={-W / 2 + 34} y={lerp(5, -1.5, frame.detailProgress)} fontSize={13.5} fontWeight={600} fill="#fff" fillOpacity={0.42 + 0.58 * a} letterSpacing="-0.01em">
              {node.label}
            </text>
            {frame.detail && (
              <text
                x={-W / 2 + 34}
                y={14}
                fontSize={10.5}
                fill={frame.tone === 'warning' && frame.toneAmount > 0.5 ? 'rgba(255,214,160,.75)' : 'rgba(235,240,248,.55)'}
                opacity={frame.detailOpacity}
              >
                {frame.detail}
              </text>
            )}
          </>
        )}
      </g>
      {risk && !mini && <RiskMarkerPill risk={risk} />}
    </g>
  );
};

/** The contextual pill under a node ("Migration detected"). Width follows its label. */
const RiskMarkerPill = ({ risk }: { readonly risk: RiskFrame }) => {
  const color = toneRgb(risk.cue.tone);
  const textWidth = risk.cue.label.length * 6.55;
  const total = textWidth + 40;
  return (
    <g opacity={risk.pill.opacity} transform={`translate(0 ${risk.pill.offsetY.toFixed(2)}) scale(${risk.pill.scale.toFixed(4)})`}>
      <rect x={-total / 2} y={-14} width={total} height={28} rx={14} fill={rgba(color, 0.12)} stroke={rgba(color, 0.38)} strokeWidth={1} />
      <circle cx={-total / 2 + 15} cy={0} r={3} fill={rgba(color, 1)} />
      <text x={-total / 2 + 25} y={4.3} fontSize={12.5} fontWeight={500} fill={risk.cue.tone === 'danger' ? '#ffc4bd' : '#ffd9a3'}>
        {risk.cue.label}
      </text>
    </g>
  );
};
