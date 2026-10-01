import type { PulseFrame } from '../../session/model/evaluateFrame';

/** A pulse travelling along a connection: soft halo + bright 2.6-unit core. */
export const FlowParticle = ({ pulse, idPrefix }: { readonly pulse: PulseFrame; readonly idPrefix: string }) => (
  <g transform={`translate(${pulse.position.x.toFixed(2)} ${pulse.position.y.toFixed(2)})`} opacity={pulse.opacity}>
    <circle r={9} fill={`url(#${idPrefix}-glow-${pulse.tone === 'warning' || pulse.tone === 'danger' ? 'warm' : 'cool'})`} />
    <circle r={2.6} fill="#fff" />
  </g>
);
