import { describe, expect, it } from 'vitest';
import { maskedSettings } from './ConnectPanel';

describe('connect preview masking', () => {
  it('shows the hooks Raio changes and masks every other value', () => {
    const shown = maskedSettings(JSON.stringify({ env: { API_TOKEN: 'secret-value' }, hooks: { Stop: [] } }));
    expect(shown).toContain('"Stop"');
    expect(shown).not.toContain('secret-value');
    expect(shown).toContain('kept unchanged');
  });

  it('describes a missing or malformed file without echoing it', () => {
    expect(maskedSettings(null)).toBe('(file does not exist)');
    expect(maskedSettings('{"env": {"K": "v"')).not.toContain('"v"');
  });
});
