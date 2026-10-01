import { useEffect, useState } from 'react';
import { easeOutCubic, lerp, progress } from '../shared/motion/easing';
import { MiniOrb } from '../features/raio/MiniOrb';
import { FloatingPanel } from '../features/panel/FloatingPanel';
import type { ArchitectureGraph } from '../features/architecture/model/types';
import type { FrameState } from '../features/session/model/evaluateFrame';
import type { ChoreographyScript } from '../features/session/model/script';

export interface FilmStageProps {
  readonly script: ChoreographyScript;
  readonly frame: FrameState;
  readonly graph: ArchitectureGraph;
  readonly project: string;
}

const STAGE = { width: 1280, height: 800 } as const;

/** Space kept for the harness dock; `?chrome=0` frees it so the stage matches the reference framing. */
const DOCK_RESERVE = new URLSearchParams(window.location.search).get('chrome') === '0' ? 0 : 72;

const useStageScale = () => {
  const compute = () => Math.min(window.innerWidth / STAGE.width, (window.innerHeight - DOCK_RESERVE) / STAGE.height);
  const [scale, setScale] = useState(compute);
  useEffect(() => {
    const onResize = () => setScale(compute());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return scale;
};

/** The concept film, 1:1: 1280×800 stage, panel at (140, 30), wordmark at y 694, 12.5s loop. */
export const FilmStage = ({ script, frame, graph, project }: FilmStageProps) => {
  const scale = useStageScale();
  const t = frame.t;
  const enter = easeOutCubic(progress(t, 0, 0.75));
  const out = progress(t, 12.0, 0.45);
  return (
    <div className="film" aria-label="Raio concept film" style={{ bottom: DOCK_RESERVE }}>
      <div className="film__stage" style={{ transform: `scale(${scale})`, opacity: 1 - out }}>
        <FloatingPanel
          className="film__panel"
          script={script}
          frame={frame}
          project={project}
          canvas={{ graph }}
          style={{
            opacity: enter,
            transform: `translateY(${(1 - enter) * 16}px) scale(${lerp(0.965, 1, enter)})`,
            filter: enter < 1 ? `blur(${(1 - enter) * 8}px)` : 'none',
          }}
        />
        <div className={`wordmark${frame.ui.wordmarkVisible ? ' wordmark--show' : ''}`}>
          <div className="wordmark__mark">
            <MiniOrb size={18} glow={0.6} bob />
            Raio
          </div>
          <div className="wordmark__tag">See where your AI goes.</div>
        </div>
      </div>
    </div>
  );
};
