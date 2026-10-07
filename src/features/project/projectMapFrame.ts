import { tokens } from '../../tokens';
import type { ArchitectureGraph } from '../architecture/model/types';
import type { FrameState } from '../session/model/evaluateFrame';
import { ORB_REST } from './layoutGroups';

/** Static dormant materials, matching an untouched session map, without creating a choreography or log. */
export const projectMapFrame = (graph: ArchitectureGraph): FrameState => ({
  t: 0,
  camera: { scale: 1, center: { x: graph.world.width / 2, y: graph.world.height / 2 } },
  orb: {
    position: ORB_REST, scale: 0.92, opacity: 0.72, headingDeg: 0, stretch: 0, behindNodeId: null,
    gaze: { x: 0, y: 0 }, eyeOpen: 0.15, happy: 0, glowCool: 0.28, glowWarm: 0, glowRadius: 30, trail: [],
  },
  nodes: new Map(graph.nodes.map((node) => [node.id, {
    activation: 0, bounce: 0, tone: 'cool' as const, toneAmount: 0, offset: { x: 0, y: 0 },
    opacity: tokens.opacity.dormantNode, detailOpacity: 0, detailProgress: 0, detail: null, touched: false,
  }])),
  edges: new Map(graph.edges.map((edge) => [edge.id, {
    revealed: false, draw: 0, opacity: 1, glowOpacity: 0, width: tokens.border.connectionDormant,
    endTone: 'cool' as const, endToneAmount: 0,
  }])),
  pulses: [], risks: [],
  ui: { status: 'ready', taskVisible: false, hint: 'waiting', validations: [], summaryVisible: false, summaryDetailVisible: false, wordmarkVisible: false, finished: false, activeNodeId: null, activeRisk: null },
  revealDim: 0, settle: 0,
});
