import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createFixtureBridge } from '../../platform/fixtureBridge';
import { projectMap } from '../project/projectMap';
import { ConnectMapPreview, readPreviewMap } from './ConnectMapPreview';
import { ConnectReview } from './ConnectPanel';

const map = projectMap({ id: 'preview', name: 'Fixture' }, { files: ['src/api/a.ts', 'src/auth/a.ts'], manifests: [], truncated: true, skipped: 1, scannedAtMs: 1 }, { files: [{ path: 'src/api/a.ts', specifiers: ['../auth/a'] }, { path: 'src/auth/a.ts', specifiers: [] }], truncated: false, skipped: 0, scannedAtMs: 1 }, { provenance: 'fixture' });

describe('read-only map in the Connect review', () => {
  it('renders the same unlit map and partial notice above the settings diff', () => {
    const markup = renderToStaticMarkup(createElement(ConnectReview, { preview: { settingsPath: 'fixture/.claude/settings.local.json', before: '{}', after: '{"hooks":{}}', gitIgnored: true }, map: { kind: 'ready', snapshot: map }, busy: false, onCancel: () => {}, onConnect: () => {} }));
    expect(markup).toContain('No session yet');
    expect(markup).toContain('Project architecture map');
    expect(markup).toContain('aria-label="API"');
    expect(markup).toContain('aria-label="Auth"');
    expect(markup).toContain(map.note);
    expect(markup.indexOf('Project architecture map')).toBeLessThan(markup.indexOf('Before'));
    expect(markup).not.toContain('Replay');
  });
  it('shows loading without fabricated areas', () => {
    const markup = renderToStaticMarkup(createElement(ConnectMapPreview, { state: { kind: 'loading' } }));
    expect(markup).toContain('Mapping project');
    expect(markup).not.toContain('<svg');
  });
  it('shows unavailability without a fake map', () => {
    const markup = renderToStaticMarkup(createElement(ConnectMapPreview, { state: { kind: 'unavailable' } }));
    expect(markup).toContain('Map unavailable for this folder');
    expect(markup).not.toContain('<svg');
  });
  it('reads a chosen folder without connecting or changing settings', async () => {
    let connected = false;
    const bridge = { ...createFixtureBridge(null), previewProjectMap: async () => map, connector: { project: () => null, chooseFolder: async () => 'fixture', preview: async () => ({ settingsPath: 'fixture/settings', before: '{}', after: '{}', gitIgnored: true }), connect: async () => { connected = true; }, disconnect: async () => { connected = false; } } };
    expect(await readPreviewMap(bridge, 'fixture')).toEqual({ kind: 'ready', snapshot: map });
    expect(connected).toBe(false);
  });
  it('treats an absent or failed adapter command as unavailable', async () => {
    expect(await readPreviewMap({ ...createFixtureBridge(null), previewProjectMap: undefined }, 'fixture')).toEqual({ kind: 'unavailable' });
    expect(await readPreviewMap({ ...createFixtureBridge(null), previewProjectMap: async () => { throw new Error('unknown command'); } }, 'fixture')).toEqual({ kind: 'unavailable' });
  });
});
