import type { OrbFrame } from '../session/model/evaluateFrame';

export interface RaioOrbProps {
  readonly frame: OrbFrame;
  /** Namespace for the SVG gradient ids declared by <RaioDefs>. */
  readonly idPrefix: string;
  /** Extra scale for small surfaces (Mini Player uses 1.5). */
  readonly sizeMultiplier?: number;
}

/**
 * Raio — the luminous companion. Rendered in world units inside an ArchitectureCanvas.
 * Everything it does (breathing, squash, gaze, blink, happy eyes, glow colour) comes from `frame`.
 */
export const RaioOrb = ({ frame, idPrefix, sizeMultiplier = 1 }: RaioOrbProps) => {
  const { position, scale, opacity, headingDeg, stretch, gaze, eyeOpen, happy, glowCool, glowWarm, glowRadius } = frame;
  return (
    <g transform={`translate(${position.x.toFixed(2)} ${position.y.toFixed(2)}) scale(${(scale * sizeMultiplier).toFixed(4)})`} opacity={opacity} aria-label="Raio">
      <circle r={glowRadius} fill={`url(#${idPrefix}-glow-cool)`} opacity={glowCool} />
      <circle r={glowRadius + 2} fill={`url(#${idPrefix}-glow-warm)`} opacity={glowWarm} />
      <g transform={`rotate(${headingDeg.toFixed(2)}) scale(${(1 + stretch).toFixed(4)} ${(1 - stretch * 0.55).toFixed(4)})`}>
        <circle r={11} fill={`url(#${idPrefix}-body)`} />
      </g>
      <ellipse cx={-3.6} cy={-5} rx={3.2} ry={1.8} fill="#fff" opacity={0.75} />
      <g transform={`translate(${gaze.x.toFixed(2)} ${gaze.y.toFixed(2)})`}>
        <ellipse cx={-3.7} cy={0.6} rx={1.45} ry={2.6 * eyeOpen} fill="#1b2544" opacity={1 - happy} />
        <ellipse cx={3.7} cy={0.6} rx={1.45} ry={2.6 * eyeOpen} fill="#1b2544" opacity={1 - happy} />
        <path
          d="M-5.3,1.4 Q-3.7,-1.2 -2.1,1.4 M2.1,1.4 Q3.7,-1.2 5.3,1.4"
          fill="none"
          stroke="#1b2544"
          strokeWidth={1.4}
          strokeLinecap="round"
          opacity={happy}
        />
      </g>
    </g>
  );
};

/** Gradients used by RaioOrb. Mount once per <svg>. */
export const RaioDefs = ({ idPrefix }: { readonly idPrefix: string }) => (
  <>
    <radialGradient id={`${idPrefix}-body`} cx="40%" cy="35%" r="70%">
      <stop offset="0" stopColor="#ffffff" />
      <stop offset=".5" stopColor="#dbe9ff" />
      <stop offset="1" stopColor="#86aefc" />
    </radialGradient>
    <radialGradient id={`${idPrefix}-glow-cool`}>
      <stop offset="0" stopColor="#a2c4ff" stopOpacity=".6" />
      <stop offset=".4" stopColor="#7fa8ff" stopOpacity=".16" />
      <stop offset="1" stopColor="#7fa8ff" stopOpacity="0" />
    </radialGradient>
    <radialGradient id={`${idPrefix}-glow-warm`}>
      <stop offset="0" stopColor="#ffcf8a" stopOpacity=".6" />
      <stop offset=".4" stopColor="#f5b65c" stopOpacity=".16" />
      <stop offset="1" stopColor="#f5b65c" stopOpacity="0" />
    </radialGradient>
  </>
);
