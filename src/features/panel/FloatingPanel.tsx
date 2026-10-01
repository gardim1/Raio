import type { CSSProperties, ReactNode } from 'react';
import { ArchitectureCanvas, type ArchitectureCanvasProps } from '../architecture/components/ArchitectureCanvas';
import type { FrameState } from '../session/model/evaluateFrame';
import type { ChoreographyScript } from '../session/model/script';
import { PanelFooter } from './PanelFooter';
import { TitleBar } from './TitleBar';

export interface FloatingPanelProps {
  readonly script: ChoreographyScript;
  readonly frame: FrameState;
  readonly canvas: Omit<ArchitectureCanvasProps, 'frame' | 'className'>;
  readonly project: string;
  readonly statusLabel?: string;
  readonly titleActions?: ReactNode;
  readonly footerCenter?: ReactNode;
  readonly footerTrailing?: ReactNode;
  readonly style?: CSSProperties;
  readonly className?: string;
}

/**
 * The canonical Raio panel from the motion concept: 1000px wide, 28px radius,
 * translucent graphite glass — title bar, 1000×520 map, footer.
 */
export const FloatingPanel = ({ script, frame, canvas, project, statusLabel, titleActions, footerCenter, footerTrailing, style, className }: FloatingPanelProps) => (
  <div className={`panel${className ? ` ${className}` : ''}`} style={style}>
    <TitleBar
      project={project}
      agent={script.agent}
      task={script.task}
      taskIsPlaceholder={script.taskIsPlaceholder === true}
      taskVisible={frame.ui.taskVisible}
      status={frame.ui.status}
      {...(statusLabel ? { statusLabel } : {})}
      actions={titleActions}
    />
    <div className="map">
      <ArchitectureCanvas {...canvas} frame={frame} className="map__svg" />
    </div>
    <PanelFooter script={script} frame={frame} center={footerCenter} trailing={footerTrailing} />
  </div>
);
