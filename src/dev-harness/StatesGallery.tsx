import { useId, type ReactNode } from 'react';
import { AgentStatus } from '../shared/ui/AgentStatus';
import { RiskPill } from '../shared/ui/RiskPill';
import { SessionSummary } from '../shared/ui/SessionSummary';
import { ValidationPill } from '../shared/ui/ValidationPill';
import { ArchitectureCanvas } from '../features/architecture/components/ArchitectureCanvas';
import { ArchitectureNode } from '../features/architecture/components/ArchitectureNode';
import { demoGraph } from '../features/architecture/model/demoProject';
import { NoProjectState } from '../features/panel/NoProjectState';
import { RaioDefs, RaioOrb } from '../features/raio/RaioOrb';
import { canonicalScript } from '../features/session/model/canonicalScript';
import { evaluateFrame, type NodeFrame, type OrbFrame } from '../features/session/model/evaluateFrame';

/** Canonical keyframes (seconds into the concept). */
export const KEYFRAMES: readonly { readonly t: number; readonly name: string }[] = [
  { t: 0.6, name: 'Idle' },
  { t: 1.3, name: 'Agent starts' },
  { t: 2.5, name: 'Auth active (scanning)' },
  { t: 3.45, name: 'Auth → API traversal' },
  { t: 4.15, name: 'API active' },
  { t: 5.55, name: 'Database warning' },
  { t: 6.3, name: 'Migration notification' },
  { t: 7.7, name: 'Validations appearing' },
  { t: 10.0, name: 'Completed' },
];

const node = (partial: Partial<NodeFrame>): NodeFrame => ({
  activation: 1,
  bounce: 0,
  tone: 'cool',
  toneAmount: 0,
  offset: { x: 0, y: 0 },
  opacity: 1,
  detailOpacity: 1,
  detailProgress: 1,
  detail: '3 files changed',
  touched: true,
  ...partial,
});

const orb = (partial: Partial<OrbFrame>): OrbFrame => ({
  position: { x: 40, y: 40 },
  scale: 1,
  opacity: 1,
  headingDeg: 0,
  stretch: 0,
  behindNodeId: null,
  gaze: { x: 0, y: 0 },
  eyeOpen: 1,
  happy: 0,
  glowCool: 0.78,
  glowWarm: 0,
  glowRadius: 30,
  trail: [],
  ...partial,
});

const Card = ({ title, children }: { readonly title: string; readonly children: ReactNode }) => (
  <figure className="gallery__card">
    <div className="gallery__stage">{children}</div>
    <figcaption>{title}</figcaption>
  </figure>
);

const NodeSwatch = ({ frame, label, selected = false }: { readonly frame: NodeFrame; readonly label: string; readonly selected?: boolean }) => {
  const id = `g${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <svg viewBox="0 0 200 90" width={200} height={90}>
      <defs>
        <filter id={`${id}-blur10`} x="-60%" y="-120%" width="220%" height="340%">
          <feGaussianBlur stdDeviation="10" />
        </filter>
      </defs>
      <ArchitectureNode node={{ id: label, label, kind: 'other', position: { x: 100, y: 45 } }} frame={frame} t={0} variant="full" idPrefix={id} selected={selected} />
    </svg>
  );
};

const OrbSwatch = ({ frame }: { readonly frame: OrbFrame }) => {
  const id = `o${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <svg viewBox="0 0 80 80" width={120} height={120}>
      <defs>
        <RaioDefs idPrefix={id} />
      </defs>
      <RaioOrb frame={frame} idPrefix={id} />
    </svg>
  );
};

/** Every reusable component in every state, plus the canonical keyframes — for design review. */
export const StatesGallery = () => (
  <div className="gallery">
    <h2>Canonical keyframes</h2>
    <div className="gallery__grid gallery__grid--wide">
      {KEYFRAMES.map((k) => (
        <Card key={k.t} title={`${k.name} — ${k.t.toFixed(2)}s`}>
          <ArchitectureCanvas graph={demoGraph} frame={evaluateFrame(canonicalScript, demoGraph, k.t)} className="gallery__map" />
        </Card>
      ))}
    </div>

    <h2>Agent status</h2>
    <div className="gallery__row">
      <AgentStatus state="ready" agent="claude" />
      <AgentStatus state="working" agent="claude" />
      <AgentStatus state="working" agent="codex" />
      <AgentStatus state="complete" agent="claude" />
      <AgentStatus state="finished" agent="claude" />
      <AgentStatus state="failed" agent="codex" />
    </div>

    <h2>Validations</h2>
    <div className="gallery__row">
      <ValidationPill kind="build" status="running" />
      <ValidationPill kind="build" status="passed" />
      <ValidationPill kind="build" status="failed" />
      <ValidationPill kind="tests" status="running" />
      <ValidationPill kind="tests" status="passed" />
      <ValidationPill kind="tests" status="failed" />
    </div>

    <h2>Risks</h2>
    <div className="gallery__row">
      <RiskPill kind="migration" />
      <RiskPill kind="dependency" />
      <RiskPill kind="config" />
      <RiskPill kind="outOfScope" />
      <RiskPill kind="migration" label="Migration failed" tone="danger" />
    </div>

    <h2>Architecture nodes</h2>
    <div className="gallery__grid">
      <Card title="Idle (dormant)"><NodeSwatch label="Payments" frame={node({ activation: 0, detail: null, touched: false, detailProgress: 0, opacity: 0.85 })} /></Card>
      <Card title="Active"><NodeSwatch label="Auth" frame={node({})} /></Card>
      <Card title="Being scanned (+ orbit)"><NodeSwatch label="Auth" frame={node({ bounce: 0.4 })} /></Card>
      <Card title="Warning"><NodeSwatch label="Database" frame={node({ tone: 'warning', toneAmount: 1, detail: '1 migration' })} /></Card>
      <Card title="Error"><NodeSwatch label="API" frame={node({ tone: 'danger', toneAmount: 1, detail: 'Tests failing' })} /></Card>
      <Card title="Validated"><NodeSwatch label="API" frame={node({ tone: 'success', toneAmount: 1, detail: '2 files, tests pass' })} /></Card>
      <Card title="Completed (settled)"><NodeSwatch label="Frontend" frame={node({ activation: 0.78, detailOpacity: 0.8, detail: '1 file changed' })} /></Card>
      <Card title="Selected"><NodeSwatch label="Auth" frame={node({})} selected /></Card>
    </div>

    <h2>Raio</h2>
    <div className="gallery__grid">
      <Card title="Sleeping (idle)"><OrbSwatch frame={orb({ eyeOpen: 0.15, scale: 0.92, opacity: 0.72, glowCool: 0.28 })} /></Card>
      <Card title="Awake / working"><OrbSwatch frame={orb({})} /></Card>
      <Card title="Scanning (gaze toward node)"><OrbSwatch frame={orb({ gaze: { x: -2.2, y: 1 } })} /></Card>
      <Card title="Travelling (squash)"><OrbSwatch frame={orb({ stretch: 0.2, headingDeg: 30, gaze: { x: 1.9, y: 1.1 } })} /></Card>
      <Card title="Warning reaction (startled, warm)"><OrbSwatch frame={orb({ eyeOpen: 1.35, glowCool: 0.15, glowWarm: 0.85, gaze: { x: 0, y: 1.8 } })} /></Card>
      <Card title="Completed (happy)"><OrbSwatch frame={orb({ happy: 1, glowCool: 0.5 })} /></Card>
    </div>

    <h2>Completion summary</h2>
    <div className="gallery__row gallery__row--summary">
      <div className="gallery__summary"><SessionSummary systems={4} reviewCount={1} checks="all-passed" visible detailVisible /></div>
      <div className="gallery__summary"><SessionSummary systems={2} reviewCount={0} checks="all-passed" visible detailVisible /></div>
    </div>

    <h2>Empty state</h2>
    <div className="gallery__grid">
      <Card title="No project detected">
        <div className="gallery__empty"><NoProjectState /></div>
      </Card>
      <Card title="Project detected (dormant map, Ready)">
        <ArchitectureCanvas graph={demoGraph} frame={evaluateFrame(canonicalScript, demoGraph, 0.4)} className="gallery__map" />
      </Card>
    </div>
  </div>
);
