import { useId } from 'react';
import type { FrameState } from '../../session/model/evaluateFrame';
import { RaioDefs, RaioOrb } from '../../raio/RaioOrb';
import { NODE_SIZE } from '../model/graph';
import type { ArchitectureGraph, NodeId } from '../model/types';
import { ArchitectureConnection } from './ArchitectureConnection';
import { ArchitectureNode, type NodeVariant } from './ArchitectureNode';
import { FlowParticle } from './FlowParticle';

export interface ArchitectureCanvasProps {
  readonly graph: ArchitectureGraph;
  readonly frame: FrameState;
  readonly variant?: NodeVariant;
  /** Follow Raio with the subtle camera (full) or keep the whole map framed (mini). */
  readonly camera?: boolean;
  readonly selectedNodeId?: NodeId | null;
  readonly onSelectNode?: (id: NodeId) => void;
  readonly onHoverNode?: (id: NodeId | null, element: SVGGElement | null) => void;
  readonly className?: string;
  /** `world` frames the full 1000×520 canvas (default); `content` crops to the systems (Mini Player). */
  readonly fit?: 'world' | 'content';
}

const CONTENT_PADDING = 36;

const contentViewBox = (graph: ArchitectureGraph): string => {
  const xs = graph.nodes.map((n) => n.position.x);
  const ys = graph.nodes.map((n) => n.position.y);
  const minX = Math.min(...xs) - NODE_SIZE.width / 2 - CONTENT_PADDING;
  const maxX = Math.max(...xs) + NODE_SIZE.width / 2 + CONTENT_PADDING;
  const minY = Math.min(...ys) - NODE_SIZE.height / 2 - CONTENT_PADDING;
  const maxY = Math.max(...ys) + NODE_SIZE.height / 2 + CONTENT_PADDING;
  return `${minX} ${minY} ${maxX - minX} ${maxY - minY}`;
};

/**
 * The live architecture map. Layer order (back → front): dotted relationships,
 * revealed connections, Raio-when-behind, nodes (with ripples + pills), pulses & trail, Raio.
 */
export const ArchitectureCanvas = ({
  graph,
  frame,
  variant = 'full',
  camera = true,
  selectedNodeId = null,
  onSelectNode,
  onHoverNode,
  className,
  fit = 'world',
}: ArchitectureCanvasProps) => {
  const idPrefix = `raio${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const { width, height } = graph.world;
  const cam = camera ? frame.camera : { scale: 1, center: { x: width / 2, y: height / 2 } };
  const transform = `translate(${width / 2} ${height / 2}) scale(${cam.scale.toFixed(4)}) translate(${(-cam.center.x).toFixed(2)} ${(-cam.center.y).toFixed(2)})`;
  const riskByNode = new Map(frame.risks.map((r) => [r.cue.nodeId, r]));
  const orbSize = variant === 'mini' ? 1.5 : 1;
  const behind = frame.orb.behindNodeId !== null;
  const orb = <RaioOrb frame={frame.orb} idPrefix={idPrefix} sizeMultiplier={orbSize} />;

  return (
    <svg className={className} viewBox={fit === 'content' ? contentViewBox(graph) : `0 0 ${width} ${height}`} role="img" aria-label="Live architecture map">
      <defs>
        <RaioDefs idPrefix={idPrefix} />
        <filter id={`${idPrefix}-blur10`} x="-60%" y="-120%" width="220%" height="340%">
          <feGaussianBlur stdDeviation="10" />
        </filter>
        <filter id={`${idPrefix}-blur3`} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" />
        </filter>
      </defs>
      <g transform={transform}>
        <g>
          {graph.edges.map((e) => {
            const ef = frame.edges.get(e.id);
            return ef && !ef.revealed ? <ArchitectureConnection key={e.id} edge={e} frame={ef} idPrefix={idPrefix} /> : null;
          })}
        </g>
        <g>
          {graph.edges.map((e) => {
            const ef = frame.edges.get(e.id);
            return ef && ef.revealed ? <ArchitectureConnection key={e.id} edge={e} frame={ef} idPrefix={idPrefix} /> : null;
          })}
        </g>
        {behind && orb}
        <g>
          {graph.nodes.map((n) => {
            const nf = frame.nodes.get(n.id);
            if (!nf) return null;
            const risk = riskByNode.get(n.id);
            return (
              <ArchitectureNode
                key={n.id}
                node={n}
                frame={nf}
                t={frame.t}
                variant={variant}
                idPrefix={idPrefix}
                selected={selectedNodeId === n.id}
                {...(risk ? { risk } : {})}
                {...(onSelectNode ? { onSelect: onSelectNode } : {})}
                {...(onHoverNode ? { onHover: onHoverNode } : {})}
              />
            );
          })}
        </g>
        <g>
          {frame.pulses.map((p) => (
            <FlowParticle key={p.key} pulse={p} idPrefix={idPrefix} />
          ))}
          {frame.orb.trail.map((tr, i) =>
            tr.opacity > 0 ? <circle key={i} cx={tr.position.x} cy={tr.position.y} r={5 * (1 - i / 9) * orbSize} fill="#cfe0ff" opacity={tr.opacity} /> : null,
          )}
        </g>
        {!behind && orb}
      </g>
    </svg>
  );
};
