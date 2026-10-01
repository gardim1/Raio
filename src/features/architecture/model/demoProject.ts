import { cubicFromSvg } from '../../../shared/geometry/cubicPath';
import { createGraph } from './graph';
import type { ArchitectureEdge, ArchitectureNode } from './types';

/**
 * The "acme-web" project from the motion concept. Coordinates and connection
 * curves are copied verbatim from the reference so every frame matches.
 */
const nodes: ArchitectureNode[] = [
  { id: 'frontend', label: 'Frontend', kind: 'frontend', position: { x: 170, y: 280 } },
  { id: 'auth', label: 'Auth', kind: 'auth', position: { x: 390, y: 150 } },
  { id: 'api', label: 'API', kind: 'api', position: { x: 590, y: 310 } },
  { id: 'db', label: 'Database', kind: 'database', position: { x: 800, y: 220 } },
  { id: 'config', label: 'Config', kind: 'config', position: { x: 190, y: 430 } },
  { id: 'payments', label: 'Payments', kind: 'payments', position: { x: 490, y: 440 } },
  { id: 'storage', label: 'Storage', kind: 'storage', position: { x: 790, y: 430 } },
];

const edge = (id: string, from: string, to: string, d: string): ArchitectureEdge => ({ id, from, to, path: cubicFromSvg(d) });

const edges: ArchitectureEdge[] = [
  edge('frontend-auth', 'frontend', 'auth', 'M236,280 C282,280 278,150 324,150'),
  edge('auth-api', 'auth', 'api', 'M390,176 C390,250 590,214 590,284'),
  edge('api-db', 'api', 'db', 'M656,310 C700,310 690,220 734,220'),
  edge('config-frontend', 'config', 'frontend', 'M190,404 C190,360 170,350 170,306'),
  edge('api-payments', 'api', 'payments', 'M570,336 C570,390 490,370 490,414'),
  edge('api-storage', 'api', 'storage', 'M640,336 C640,390 770,360 770,404'),
  edge('db-storage', 'db', 'storage', 'M812,246 C812,320 810,350 810,404'),
];

export const demoGraph = createGraph(nodes, edges);
