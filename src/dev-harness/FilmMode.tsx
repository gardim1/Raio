import { demoGraph } from '../features/architecture/model/demoProject';
import { FilmStage } from './FilmStage';
import { canonicalScript } from '../features/session/model/canonicalScript';
import { evaluateFrame } from '../features/session/model/evaluateFrame';
import { usePlayback } from '../shared/motion/usePlayback';
import { tokens } from '../tokens';

/** Plays the approved concept film on a loop — the 1:1 reference. */
export const FilmMode = () => {
  const playback = usePlayback({ loopAt: tokens.motion.duration.filmLoop / 1000, reducedMotionAt: 10 });
  const frame = evaluateFrame(canonicalScript, demoGraph, playback.t);
  return <FilmStage script={canonicalScript} frame={frame} graph={demoGraph} project="acme-web" />;
};
