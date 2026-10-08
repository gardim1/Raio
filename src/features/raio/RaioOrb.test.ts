import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ArchitectureCanvas } from '../architecture/components/ArchitectureCanvas';
import { demoGraph } from '../architecture/model/demoProject';
import { canonicalScript } from '../session/model/canonicalScript';
import { evaluateFrame } from '../session/model/evaluateFrame';
import { RaioOrb } from './RaioOrb';

const source = vi.hoisted(() => ({ source: 'live' }));
vi.mock('../session/store/sessionStore', () => ({ useSessionUi: (select: (state: typeof source) => unknown) => select(source) }));
vi.mock('react', async importOriginal => ({ ...await importOriginal<typeof import('react')>(), useId: () => 'map-test' }));
const frame = evaluateFrame(canonicalScript, demoGraph, 2.4);
describe('map character integration', () => {
  it('preserves world position/scale/opacity and replaces the frame-owned face with the shared drawing', () => {
    source.source = 'live';
    const orb = { ...frame.orb, position: { x: 123, y: 456 }, scale: .8, opacity: .6 };
    const companion = { state: 'failure' as const, label: 'Failure', description: 'Failure', records: [], activeUntil: null };
    const markup = renderToStaticMarkup(createElement(RaioOrb, { frame: orb, idPrefix: 'old', sizeMultiplier: 1.5, companion }));
    expect(markup).toContain('translate(123.00 456.00) scale(1.2000)');
    expect(markup).toContain('opacity="0.6"');
    expect(markup).toContain('data-character-size="map"');
    expect(markup).toContain('data-character-mode="failure"');
    expect(markup).not.toContain('old-glow'); expect(markup).not.toContain('<ellipse');
  });
  it('replay uses the displayed frame instead of the current live failure', () => {
    source.source = 'replay';
    const companion = { state: 'failure' as const, label: 'Failure', description: 'Failure', records: [], activeUntil: null };
    const markup = renderToStaticMarkup(createElement(RaioOrb, { frame: frame.orb, idPrefix: 'map', companion, ui: { status: 'working', activeRisk: null } }));
    expect(markup).toContain('data-character-mode="working"');
    source.source = 'live';
  });
  it('keeps the same sibling identity while crossing a node front/back boundary', () => {
    const findOrb = (behind: string | null) => {
      const tree = ArchitectureCanvas({ graph: demoGraph, frame: { ...frame, orb: { ...frame.orb, behindNodeId: behind } } });
      const world = Children.toArray(tree.props.children).at(-1) as ReactElement<{ children: ReactNode }>;
      return Children.toArray(world.props.children).find(child => isValidElement(child) && child.type === RaioOrb) as ReactElement;
    };
    const front = findOrb(null), back = findOrb('auth');
    expect(front).toBeDefined(); expect(back).toBeDefined();
    expect(front.key).toBe(back.key);
    // React's explicit-key prefix is unchanged when the sibling slot moves; index keys are not.
    expect(front.key).toContain('$');
  });
});
