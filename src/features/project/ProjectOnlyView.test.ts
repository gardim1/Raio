import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const windowApi = vi.hoisted(() => ({ close: async () => {}, minimize: async () => {}, toggleMaximize: async () => {}, startDragging: async () => {} }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => windowApi }));

import { BridgeProvider } from '../../platform/BridgeContext';
import type { DesktopBridge } from '../../platform/desktopBridge';
import { createFixtureBridge } from '../../platform/fixtureBridge';
import { projectMap } from './projectMap';
import { ProjectOnlyView } from './ProjectOnlyView';
import { projectMapFrame } from './projectMapFrame';
import { ExpandedWindow } from '../modes/ExpandedWindow';
import { derivePresence } from '../modes/presence';
import { compileReplay } from '../session/model/compileReplay';
import type { SessionLog } from '../session/model/events';
import { deriveInsights } from '../session/model/insights';

const oneSystem = projectMap({ id: 'qa', name: 'QA fixture' }, { files: ['package.json'], manifests: [], truncated: false, skipped: 0, scannedAtMs: 1 }, null, { provenance: 'fixture' });
const render = (bridge: DesktopBridge, snapshot = oneSystem) => renderToStaticMarkup(createElement(BridgeProvider, {
  bridge, children: createElement(ProjectOnlyView, { snapshot, mode: 'expanded' }),
}));
afterEach(() => vi.unstubAllGlobals());

describe('pre-session Expanded window', () => {
  it('renders native titlebar controls using the injected Windows window API', () => {
    vi.stubGlobal('navigator', { userAgent: 'Windows NT 10.0' });
    const markup = render({ ...createFixtureBridge(null), kind: 'native', fixedSurface: 'expanded' });
    expect(markup).toContain('titlebar--native');
    expect(markup).toContain('aria-label="Close window"');
    expect(markup).toContain('aria-label="Minimize window"');
    expect(markup).toContain('aria-label="Maximize or restore window"');
  });

  it.each(['Windows NT 10.0', 'Macintosh'])('keeps fixture chrome decorative on %s', (userAgent) => {
    vi.stubGlobal('navigator', { userAgent });
    expect(render(createFixtureBridge(null))).not.toContain('titlebar--native');
    expect(render(createFixtureBridge(null))).not.toContain('aria-label="Close window"');
  });

  it('keeps native non-Windows chrome decorative', () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
    expect(render({ ...createFixtureBridge(null), kind: 'native', fixedSurface: 'expanded' })).not.toContain('titlebar--native');
  });

  it('uses singular copy for exactly one mapped system', () => {
    expect(oneSystem.graph.nodes).toHaveLength(1);
    expect(render(createFixtureBridge(null))).toContain('1 system mapped');
    expect(render(createFixtureBridge(null))).not.toContain('1 systems mapped');
  });
});

describe('ready live Expanded map heading', () => {
  it.each([
    { files: [], expected: '0 systems mapped' },
    { files: ['package.json'], expected: '1 system mapped' },
    { files: ['package.json', 'src/api/a.ts'], expected: '2 systems mapped' },
  ])('renders $expected', ({ files, expected }) => {
    const graph = projectMap({ id: 'qa', name: 'QA fixture' }, { files, manifests: [], truncated: false, skipped: 0, scannedAtMs: 1 }, null).graph;
    const log: SessionLog = { id: 'qa-ready', agent: 'unknown', task: 'QA fixture', project: 'QA fixture', startedAt: '2026-10-07T00:00:00Z', events: [] };
    const script = compileReplay(log, graph);
    const frame = projectMapFrame(graph);
    const noop = () => {};
    const markup = renderToStaticMarkup(createElement(BridgeProvider, { bridge: createFixtureBridge(null), children: createElement(ExpandedWindow, {
      graph, script, frame, project: log.project, insights: deriveInsights(log), presence: derivePresence(script, graph, frame, false),
      selectedNodeId: null, isReplay: false, onSelectNode: noop, onSelectEvent: noop, onPinMini: noop, onIsland: noop, onViewChanges: noop,
    }) }));
    expect(markup).toContain(`<div class="sidebar__task">${expected}</div>`);
  });
});
