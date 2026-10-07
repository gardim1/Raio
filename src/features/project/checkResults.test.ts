import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SessionSummary } from '../../shared/ui/SessionSummary';
import { EvidencePanel } from '../panel/EvidencePanel';
import { PanelFooter } from '../panel/PanelFooter';
import type { RaioEvent } from '../ingest/raioEvent';
import { compileReplay } from '../session/model/compileReplay';
import { evaluateFrame } from '../session/model/evaluateFrame';
import { describeValidation } from './projectInsights';
import { projectSessionDetailed } from './projectSession';

const project = { id: 'checks', name: 'check-fixture' };
const event = (seq: number, kind: RaioEvent['kind'], evidence: RaioEvent['evidence'] = {}): RaioEvent => ({
  schema: 1, id: `check-${seq}`, projectId: project.id, sessionId: 's1', agent: 'claude',
  source: 'fixture', provenance: 'fixture', attribution: 'session', sourceAt: seq * 1000,
  observedAt: seq * 1000, seq, kind, paths: [], evidence,
});
const reasons = [
  { detail: 'interrupted', text: 'result unknown · interrupted' },
  { detail: 'background command', text: 'result unknown · ran in the background' },
  { detail: 'compound command', text: 'result unknown · combined with other commands' },
  { detail: 'result not established', text: "result unknown · tool result can't confirm it" },
  { detail: undefined, text: 'result unknown' },
  { detail: 'unrecognized detail', text: 'result unknown' },
  { detail: 'constructor', text: 'result unknown' },
] as const;

// Compare visible text, since React may escape punctuation and insert separators between text nodes.
const textOf = (markup: string) => markup.replace(/<[^>]*>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');

describe('check result copy', () => {
  it.each(reasons)('maps evidence detail $detail to safe, short unknown wording', ({ detail, text }) => {
    const validation = { kind: 'tests' as const, status: 'unknown' as const, recordedStatus: 'unknown' as const, atMs: 1000, detail };
    expect(describeValidation(validation)).toBe(`Tests: ${text}`);
  });

  it.each(reasons)('carries unknown detail $detail through Bash/PowerShell live and replay views', ({ detail, text }) => {
    for (const toolName of ['Bash', 'PowerShell']) {
      const projected = projectSessionDetailed(project, [
        event(1, 'session.started'),
        event(2, 'command.observed', { commandClass: 'test', toolName, toolUseId: 'test' }),
        event(3, 'command.result', { commandClass: 'test', toolName, toolUseId: 'test', detail }),
        event(4, 'session.ended'),
      ])!;
      expect(projected.insights.validations.at(-1)?.status).toBe('unknown');
      const evidenceText = textOf(renderToStaticMarkup(createElement(EvidencePanel, { evidence: projected.insights })));
      expect(evidenceText).toContain(`Tests: ${text}`);
      if (detail === 'unrecognized detail' || detail === 'constructor') expect(evidenceText).not.toContain(detail);
      for (const live of [false, true]) {
        const script = compileReplay(projected.snapshot.log, projected.snapshot.graph, { live });
        expect(script.summary.checks).toBe('unverified');
        expect(script.story.map((s) => s.label)).toContain(`Tests: ${text}`);
        const frame = evaluateFrame(script, projected.snapshot.graph, script.duration + 1);
        const footerText = textOf(renderToStaticMarkup(createElement(PanelFooter, { script, frame })));
        expect(footerText).toContain(`Tests ${text}`);
        expect(footerText).not.toContain('Everything validated');
        if (detail === 'unrecognized detail' || detail === 'constructor') expect(footerText).not.toContain(detail);
      }
    }
  });

  it('renders a summary with zero observations without claiming that no checks ran', () => {
    const projected = projectSessionDetailed(project, [event(1, 'session.started'), event(2, 'session.ended')])!;
    const script = compileReplay(projected.snapshot.log, projected.snapshot.graph);
    const summaryText = textOf(renderToStaticMarkup(createElement(SessionSummary, { ...script.summary, visible: true, detailVisible: true })));
    expect(script.summary.checks).toBe('none-observed');
    expect(summaryText).toContain('No checks observed');
    expect(summaryText).not.toContain('No checks ran');
    expect(summaryText).not.toContain('Everything validated');
  });

  it.each([0, 1])('uses captured PowerShell exit code %s without filtering by tool name', (exitCode) => {
    const projected = projectSessionDetailed(project, [
      event(1, 'session.started'),
      event(2, 'command.observed', { commandClass: 'build', toolName: 'PowerShell', toolUseId: 'build' }),
      event(3, 'command.result', { toolName: 'PowerShell', toolUseId: 'build', exitCode }),
      event(4, 'session.ended'),
    ])!;
    const script = compileReplay(projected.snapshot.log, projected.snapshot.graph);
    expect(script.validations.map((v) => v.status)).toEqual([exitCode === 0 ? 'passed' : 'failed']);
    expect(script.summary.checks).toBe(exitCode === 0 ? 'all-passed' : 'some-failed');
  });

  it('retains successive unknown reasons of the same check in live history and shows the latest in the footer', () => {
    const projected = projectSessionDetailed(project, [
      event(1, 'session.started'),
      event(2, 'command.result', { commandClass: 'test', detail: 'interrupted' }),
      event(3, 'command.result', { commandClass: 'test', detail: 'compound command' }),
      event(4, 'session.ended'),
    ])!;
    const script = compileReplay(projected.snapshot.log, projected.snapshot.graph, { live: true });
    expect(script.validations).toHaveLength(2);
    expect(script.story.map((s) => s.label)).toContain('Tests: result unknown · interrupted');
    expect(script.story.map((s) => s.label)).toContain('Tests: result unknown · combined with other commands');
    const frame = evaluateFrame(script, projected.snapshot.graph, script.duration + 1);
    const footerText = textOf(renderToStaticMarkup(createElement(PanelFooter, { script, frame })));
    expect(footerText).toContain('Tests result unknown · combined with other commands');
    expect(footerText).not.toContain('interrupted');
  });
});
