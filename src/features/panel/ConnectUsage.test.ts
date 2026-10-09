import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { ConnectReview } from './ConnectPanel';
import type { ConnectPreview } from '../../platform/desktopBridge';
import type { UsageOptIn } from '../../platform/desktopBridge';
const preview: ConnectPreview = { settingsPath:'fixture/.claude/settings.local.json', before:'{}', after:'{}', gitIgnored:true,
  usage:{ enabled:false, replaceExisting:false, effective:'user', fingerprint:'synthetic', before:null, after:null, reason:null } };
const render = (p = preview, usageChoice?: UsageOptIn) => renderToStaticMarkup(createElement(ConnectReview, { preview:p, usageChoice, busy:false, onCancel:() => {}, onConnect:() => {} }));
it('shows the separate off-by-default opt-in and project-only replacement for an inherited line', () => {
  const html = render();
  expect(html).toContain('Show Claude plan usage (5-hour and weekly limits)');
  expect(html).toContain('Use Raio&#x27;s status line in this project only');
  expect(html).toContain('user settings');
  expect(html).toContain("empty status line row instead of some footer hints");
  expect(html).not.toMatch(/type="checkbox" checked/);
  expect(html).toMatch(/type="radio"[^>]*checked/);
});
it('shows the exact statusLine diff without exposing unrelated settings', () => {
  const html = render({ ...preview, before:JSON.stringify({env:{SECRET:'PRIVATE'}}), usage:{ ...preview.usage!, enabled:true, replaceExisting:true,
    after:{type:'command',command:"'C:/Raio/raio-hook.exe' statusline --project p --root 'C:/fixture' --raio-managed"} } });
  expect(html).toContain('Raio status line in this project only'); expect(html).not.toContain('PRIVATE');
  expect(html).not.toContain('statusline --project p');
});
it('managed policy blocks enabling usage but still allows a hooks-only connection', () => {
  const html = render({ ...preview, usage:{ ...preview.usage!, effective:'managed', reason:'Managed settings prevent an override.' } });
  expect(html).toContain('Managed settings prevent an override.');
  expect(html).not.toContain('Replace it in this project only');
});

it('keeps the primary Connect action available while usage details are pending', () => {
  const html = renderToStaticMarkup(createElement(ConnectReview, { preview, busy:false, updatingUsage:true, onCancel:() => {}, onConnect:() => {} }));
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('Updating preview');
  expect(html).not.toContain('<fieldset disabled="">');
  expect(html).toContain('button type="button"');
  expect(html).not.toContain('disabled=""');
});

it('renders the latest local usage choice while its preview is pending', () => {
  const html = render(preview, { enabled:true, replaceExisting:true });
  expect(html).toMatch(/type="checkbox" checked/);
  expect(html).toMatch(/type="radio"[^>]*checked/);
  expect(html).not.toMatch(/type="radio"[^>]*checked[^>]*>Keep my status line/);
});

it('keeps the folder and one-sentence change summary in the primary review', () => {
  const html = render();
  expect(html).toContain('Raio adds its hooks to');
  expect(html).toContain('fixture/.claude/settings.local.json');
  expect(html).toContain('Details');
  expect(html).toContain('Keep my status line (Raio shows no plan usage)');
  expect(html).toContain('Use Raio&#x27;s status line in this project only');
});
