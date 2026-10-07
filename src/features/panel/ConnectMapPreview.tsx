import type { DesktopBridge } from '../../platform/desktopBridge';
import type { ProjectMapSnapshot } from '../project/projectMap';
import { ArchitectureCanvas } from '../architecture/components/ArchitectureCanvas';
import { projectMapFrame } from '../project/projectMapFrame';

export type PreviewMapState = { readonly kind: 'loading' } | { readonly kind: 'unavailable' } | { readonly kind: 'ready'; readonly snapshot: ProjectMapSnapshot };
export const readPreviewMap = async (bridge: DesktopBridge, root: string): Promise<PreviewMapState> => {
  try {
    const snapshot = await bridge.previewProjectMap?.(root);
    return snapshot ? { kind: 'ready', snapshot } : { kind: 'unavailable' };
  } catch { return { kind: 'unavailable' }; }
};
export const ConnectMapPreview = ({ state }: { readonly state: PreviewMapState }) => {
  if (state.kind === 'loading') return <p className="evidence__note" role="status">Mapping project…</p>;
  if (state.kind === 'unavailable') return <p className="evidence__note" role="status">Map unavailable for this folder</p>;
  const { snapshot } = state;
  return <section className="connect__map" aria-label="Folder map preview">
    <p className="connect__body">{snapshot.project.name} · No session yet</p>
    <ArchitectureCanvas graph={snapshot.graph} frame={projectMapFrame(snapshot.graph)} camera={false} fit={snapshot.graph.nodes.length ? 'content' : 'world'} className="map__svg" label="Project architecture map" />
    <p className="evidence__note">{snapshot.note}</p>
    {snapshot.provenance === 'fixture' && <p className="evidence__note">Demo fixture · not real agent activity</p>}
  </section>;
};
