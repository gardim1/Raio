import { RISK_LABEL } from './events';
import type { ChoreographyScript } from './script';

const HOME = { x: 480, y: 262 } as const;

/**
 * The canonical "Add Google authentication" sequence — every value below is copied
 * from the approved motion concept. This is the visual source of truth; the replay
 * compiler is tested against it.
 */
export const canonicalScript: ChoreographyScript = {
  id: 'canonical-add-google-auth',
  agent: 'claude',
  task: 'Add Google authentication',
  duration: 10,
  home: HOME,
  orb: [
    { kind: 'sleep', t0: 0, t1: 1.0, at: HOME },
    { kind: 'wake', t0: 1.0, t1: 1.4, at: HOME, hopHeight: 9 },
    { kind: 'arc', t0: 1.4, t1: 2.1, to: { x: 390, y: 190 }, lift: 26 },
    { kind: 'orbit', t0: 2.1, t1: 3.0, nodeId: 'auth', center: { x: 390, y: 150 }, rx: 86, ry: 40, startAngle: Math.PI / 2, turns: 1 },
    { kind: 'edge', t0: 3.0, t1: 3.9, edgeId: 'auth-api', p0: 0.07, p1: 1 },
    { kind: 'settle', t0: 3.9, t1: 4.35, to: { x: 590, y: 266 }, duration: 0.28 },
    { kind: 'arc', t0: 4.35, t1: 4.6, to: { x: 656, y: 310 }, lift: 14 },
    { kind: 'edge', t0: 4.6, t1: 5.35, edgeId: 'api-db', p0: 0, p1: 1 },
    { kind: 'arc', t0: 5.35, t1: 5.6, to: { x: 800, y: 178 }, lift: 18 },
    { kind: 'hover', t0: 5.6, t1: 8.0, at: { x: 800, y: 178 }, gaze: 'down', startle: { t0: 5.6, duration: 0.35, height: 11 } },
    { kind: 'arc', t0: 8.0, t1: 8.9, to: HOME, lift: 60 },
    { kind: 'rest', t0: 8.9, t1: Infinity, at: HOME, gazeViewerAt: 9.2 },
  ],
  nodes: [
    { nodeId: 'auth', activateAt: 1.6, detail: '3 files changed' },
    { nodeId: 'frontend', activateAt: 2.05, detail: '1 file changed' },
    { nodeId: 'api', activateAt: 3.9, detail: '2 files changed' },
    { nodeId: 'db', activateAt: 5.35, detail: '1 migration', toneShift: { tone: 'warning', at: 5.45 } },
  ],
  edges: [
    { edgeId: 'frontend-auth', revealAt: 2.0, revealDuration: 0.9 },
    { edgeId: 'auth-api', revealAt: 2.95, revealDuration: 0.9 },
    { edgeId: 'api-db', revealAt: 4.5, revealDuration: 0.8 },
  ],
  pulses: [
    { edgeId: 'frontend-auth', t0: 2.8, duration: 0.45, tone: 'cool' },
    { edgeId: 'auth-api', t0: 3.45, duration: 0.55, tone: 'cool' },
    { edgeId: 'api-db', t0: 5.25, duration: 0.4, tone: 'warning' },
    { edgeId: 'frontend-auth', t0: 7.25, duration: 0.38, tone: 'cool' },
    { edgeId: 'auth-api', t0: 7.6, duration: 0.42, tone: 'cool' },
    { edgeId: 'api-db', t0: 8.0, duration: 0.36, tone: 'warning' },
  ],
  risks: [{ nodeId: 'db', kind: 'migration', label: RISK_LABEL.migration, tone: 'warning', at: 5.45, pillAt: 5.65 }],
  validations: [
    { kind: 'build', status: 'passed', at: 7.0 },
    { kind: 'tests', status: 'passed', at: 7.4 },
  ],
  status: [
    { at: 0, state: 'ready' },
    { at: 1.0, state: 'working' },
    { at: 8.2, state: 'complete' },
  ],
  taskVisible: { from: 1.0, to: 8.4 },
  camera: { focusIn: { t0: 1.3, duration: 0.8 }, focusOut: { t0: 6.5, duration: 1.0 }, zoom: 1.13, follow: 0.5 },
  reveal: { t0: 6.6, duration: 0.8 },
  settle: { t0: 8.4, duration: 0.8 },
  summary: { at: 8.6, detailAt: 8.95, systems: 4, reviewCount: 1, checks: 'all-passed' },
  mood: { wakeAt: 1.0, blinks: [1.6, 3.95, 6.4, 10.6], happy: { t0: 8.85, duration: 1.55 }, warmGlow: { from: 5.45, to: 7.6 }, calmAt: 8.6 },
  story: [
    { t: 1.0, label: 'Claude started “Add Google authentication”', tone: 'neutral', realTime: '00:00' },
    { t: 1.6, label: 'Inspecting Auth', nodeId: 'auth', tone: 'cool', realTime: '00:41' },
    { t: 2.05, label: 'Frontend updated', nodeId: 'frontend', tone: 'cool', realTime: '03:12' },
    { t: 3.9, label: 'API session routes updated', nodeId: 'api', tone: 'cool', realTime: '06:05' },
    { t: 5.45, label: 'Migration file added in Database', nodeId: 'db', tone: 'warning', realTime: '08:47' },
    { t: 7.0, label: 'Build passed', tone: 'success', realTime: '12:58' },
    { t: 7.4, label: 'Tests passed', tone: 'success', realTime: '14:03' },
    { t: 8.2, label: 'Claude finished', tone: 'neutral', realTime: '14:32' },
  ],
  wordmarkAt: 9.25,
};
