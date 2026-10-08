import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const windowApi = vi.hoisted(() => ({ close: async () => {}, minimize: async () => {}, toggleMaximize: async () => {}, startDragging: async () => {}, isMaximized: async () => false, onResized: async () => () => {} }));
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
import { canonicalScript } from '../session/model/canonicalScript';
import { evaluateFrame } from '../session/model/evaluateFrame';

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
    expect(markup).toContain('aria-label="Close (Raio keeps running; quit from the tray)"');
    expect(markup).toContain('aria-label="Minimize"');
    expect(markup).toContain('aria-label="Maximize"');
  });

  it.each(['Windows NT 10.0', 'Macintosh'])('keeps fixture chrome decorative on %s', (userAgent) => {
    vi.stubGlobal('navigator', { userAgent });
    expect(render(createFixtureBridge(null))).not.toContain('titlebar--native');
    expect(render(createFixtureBridge(null))).not.toContain('titlebar__caption');
  });

  it('keeps native non-Windows chrome decorative', () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
    expect(render({ ...createFixtureBridge(null), kind: 'native', fixedSurface: 'expanded' })).not.toContain('titlebar--native');
  });

  it('uses singular copy for exactly one mapped system', () => {
    expect(oneSystem.graph.nodes).toHaveLength(1);
    expect(render(createFixtureBridge(null))).toContain('1 area');
    expect(render(createFixtureBridge(null))).not.toContain('1 systems mapped');
  });
  it('keeps the folder name once in the sidebar, hides technical details and avoids repeated waiting copy', () => {
    const name = 'Pasta com acentos ação e espaços ' + 'muito longa '.repeat(8);
    const snapshot = { ...oneSystem, project: { id: 'fixture', name } };
    const html = render(createFixtureBridge(null), snapshot);
    const sidebar = html.match(/<aside class="sidebar">([\s\S]*?)<\/aside>/)![1]!;
    expect(sidebar.match(new RegExp('>' + name + '<', 'g'))).toHaveLength(1);
    expect(sidebar).toContain('title="' + name + '"');
    expect(sidebar).toContain('aria-label="' + name + '"');
    expect(sidebar).toContain('Connected · no activity yet');
    expect(sidebar).toContain('Waiting for activity');
    expect(html.match(/Start a new Claude Code session in this folder/g)).toHaveLength(1);
    expect(html).not.toContain('Waiting for an agent session');
    expect(sidebar).toContain('aria-expanded="false"');
    expect(sidebar).toContain('About this map');
    expect(sidebar).not.toContain('Connected to');
  });
});

describe('session Expanded overview', () => {
  it.each([
    { files: [], expected: '0 areas' },
    { files: ['package.json'], expected: '1 area' },
    { files: ['package.json', 'src/api/a.ts'], expected: '2 areas' },
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
    expect(markup).toContain('<div class="sidebar__task">Session activity</div>');
    expect(markup).toContain(`${expected} · heuristic map`);
    expect(markup).not.toContain('systems mapped');
    expect(markup).not.toMatch(/Start .* in this repository|Start a new Claude/);
  });
});

it('retains the selected area inspector and its file details after the sidebar changes', () => {
  const fixture = createFixtureBridge();
  const snapshot = fixture.currentSession()!;
  const frame = evaluateFrame(canonicalScript, snapshot.graph, canonicalScript.duration);
  const insights = deriveInsights(snapshot.log);
  const auth = snapshot.graph.nodeById.get('auth')!;
  const file = insights.byNode.get(auth.id)!.files[0]!.path;
  const noop = () => {};
  const html = renderToStaticMarkup(createElement(BridgeProvider, { bridge: fixture, children: createElement(ExpandedWindow, {
    graph: snapshot.graph, script: canonicalScript, frame, project: snapshot.project, insights,
    presence: derivePresence(canonicalScript, snapshot.graph, frame, false), selectedNodeId: auth.id, isReplay: false,
    onSelectNode: noop, onSelectEvent: noop, onPinMini: noop, onIsland: noop, onViewChanges: noop,
  }) }));
  expect(html).toContain('<section class="inspector" aria-label="Auth details">');
  expect(html).toContain('aria-label="Close details"');
  expect(html).toContain('<ul class="inspector__files">');
  expect(html).toContain(file);
});

it.each([
  { time: 0, replay: false },
  { time: 4, replay: false },
  { time: 4, replay: true },
  { time: canonicalScript.duration, replay: true },
])('uses one Windows caption bar for session time=$time, replay=$replay', ({ time, replay }) => {
  vi.stubGlobal('navigator', { userAgent: 'Windows NT 10.0' });
  const fixture = createFixtureBridge();
  const snapshot = fixture.currentSession()!;
  const frame = evaluateFrame(canonicalScript, snapshot.graph, time);
  const noop = () => {};
  const html = renderToStaticMarkup(createElement(BridgeProvider, {
    bridge: { ...fixture, kind: 'native', fixedSurface: 'expanded' },
    children: createElement(ExpandedWindow, { graph: snapshot.graph, script: canonicalScript, frame, project: snapshot.project,
      insights: deriveInsights(snapshot.log), presence: derivePresence(canonicalScript, snapshot.graph, frame, replay),
      selectedNodeId: null, isReplay: replay, onSelectNode: noop, onSelectEvent: noop, onPinMini: noop, onIsland: noop, onViewChanges: noop }),
  }));
  expect(html.match(/class="titlebar /g)).toHaveLength(1);
  expect(html.match(/class="titlebar__caption"/g)).toHaveLength(1);
  expect(html).not.toContain('titlebar__dots');
  for (const label of ['Minimize', 'Maximize', 'Close (Raio keeps running; quit from the tray)', 'Open Mini Player', 'Show as Island']) {
    expect(html).toContain('aria-label="' + label + '"');
  }
});
