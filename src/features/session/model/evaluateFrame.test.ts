import { describe, expect, it } from 'vitest';
import { demoGraph } from '../../architecture/model/demoProject';
import { canonicalScript } from './canonicalScript';
import { evaluateFrame, orbPosition } from './evaluateFrame';

const at = (t: number) => evaluateFrame(canonicalScript, demoGraph, t);

describe('evaluateFrame — canonical concept', () => {
  it('rests Raio at home while asleep and reaches the Auth orbit at 2.1s', () => {
    expect(orbPosition(canonicalScript, demoGraph, 0)).toEqual({ x: 480, y: 262 });
    const p = orbPosition(canonicalScript, demoGraph, 2.1);
    expect(p.x).toBeCloseTo(390, 3);
    expect(p.y).toBeCloseTo(190, 3);
  });

  it('moves Raio continuously (no frame jumps larger than travel speed allows)', () => {
    let previous = orbPosition(canonicalScript, demoGraph, 0);
    for (let t = 1 / 60; t <= 12; t += 1 / 60) {
      const p = orbPosition(canonicalScript, demoGraph, t);
      expect(Math.hypot(p.x - previous.x, p.y - previous.y)).toBeLessThan(32);
      previous = p;
    }
  });

  it('activates nodes in the canonical order and turns the Database amber', () => {
    expect(at(1.5).nodes.get('auth')!.activation).toBe(0);
    expect(at(2.1).nodes.get('auth')!.activation).toBeGreaterThan(0.99);
    expect(at(5.2).nodes.get('db')!.activation).toBe(0);
    const db = at(6.2).nodes.get('db')!;
    expect(db.tone).toBe('warning');
    expect(db.toneAmount).toBeCloseTo(1, 5);
  });

  it('draws the Auth → API connection between 2.95s and 3.85s', () => {
    expect(at(2.9).edges.get('auth-api')!.draw).toBe(0);
    expect(at(3.4).edges.get('auth-api')!.draw).toBeGreaterThan(0.4);
    expect(at(3.86).edges.get('auth-api')!.draw).toBe(1);
  });

  it('walks the status pill Ready → Claude working → Complete', () => {
    expect(at(0.5).ui.status).toBe('ready');
    expect(at(1.0).ui.status).toBe('working');
    expect(at(8.2).ui.status).toBe('complete');
  });

  it('shows the migration pill and then the completion summary', () => {
    expect(at(5.6).risks[0]!.pill.opacity).toBe(0);
    expect(at(6.3).risks[0]!.pill.opacity).toBeCloseTo(1, 5);
    expect(at(8.59).ui.summaryVisible).toBe(false);
    expect(at(8.6).ui.summaryVisible).toBe(true);
  });

  it('sends Raio behind the Auth node during the far half of the orbit', () => {
    const behind = [2.3, 2.4, 2.5, 2.6, 2.7].some((t) => at(t).orb.behindNodeId === 'auth');
    expect(behind).toBe(true);
    expect(at(2.12).orb.behindNodeId).toBeNull();
  });
});
