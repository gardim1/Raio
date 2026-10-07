import type { ProjectMapSnapshot } from '../features/project/projectMap';
import type { DesktopBridge } from './desktopBridge';

/** Additive renderer capability: project data is separate from the session-only bridge snapshot. */
export interface ProjectMapBridge extends DesktopBridge {
  currentProjectMap(): ProjectMapSnapshot | null;
}

export const readProjectMap = (bridge: DesktopBridge): ProjectMapSnapshot | null =>
  (bridge as DesktopBridge & Partial<ProjectMapBridge>).currentProjectMap?.() ?? null;
