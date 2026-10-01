import { describe, expect, it } from 'vitest';
import { agentFullName, agentShortName, withAgent } from './agentName';

describe('agent names', () => {
  it('uses the product name for headings and never doubles the suffix', () => {
    expect(agentFullName('claude')).toBe('Claude Code');
    expect(agentFullName('codex')).toBe('Codex');
  });

  it('uses the short name for status and story copy', () => {
    expect(agentShortName('claude')).toBe('Claude');
    expect(agentShortName('codex')).toBe('Codex');
  });

  it('never presents an unidentified agent as Claude', () => {
    expect(agentShortName('unknown')).toBe('Agent');
    expect(agentFullName('unknown')).toBe('Unknown agent');
    expect(withAgent('{agent} finished', 'unknown')).toBe('Agent finished');
  });

  it('substitutes the {agent} placeholder in story labels', () => {
    expect(withAgent('{agent} started “Add Google authentication”', 'codex')).toBe('Codex started “Add Google authentication”');
    expect(withAgent('{agent} finished', 'claude')).toBe('Claude finished');
    expect(withAgent('Build passed', 'codex')).toBe('Build passed');
  });
});
