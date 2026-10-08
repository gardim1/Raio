import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { ConnectReview } from './ConnectPanel';
import type { ConnectPreview } from '../../platform/desktopBridge';
const preview: ConnectPreview = { settingsPath:'fixture/.claude/settings.local.json', before:'{}', after:'{}', gitIgnored:true,
  usage:{ enabled:false, replaceExisting:false, effective:'user', fingerprint:'synthetic', before:null, after:null, reason:null } };
const render = (p = preview) => renderToStaticMarkup(createElement(ConnectReview, { preview:p, busy:false, onCancel:() => {}, onConnect:() => {} }));
it('shows the separate off-by-default opt-in and project-only replacement for an inherited line', () => {
  const html = render();
  expect(html).toContain('Show Claude plan usage (5-hour and weekly limits)');
  expect(html).toContain('Replace it in this project only');
  expect(html).toContain('user settings');
  expect(html).toContain("empty status line row instead of some footer hints");
  expect(html).not.toContain('checked=""');
});
it('shows the exact statusLine diff without exposing unrelated settings', () => {
  const html = render({ ...preview, before:JSON.stringify({env:{SECRET:'PRIVATE'}}), usage:{ ...preview.usage!, enabled:true, replaceExisting:true,
    after:{type:'command',command:"'C:/Raio/raio-hook.exe' statusline --project p --root 'C:/fixture' --raio-managed"} } });
  expect(html).toContain('statusline --project p'); expect(html).not.toContain('PRIVATE');
});
it('managed policy blocks enabling usage but still allows a hooks-only connection', () => {
  const html = render({ ...preview, usage:{ ...preview.usage!, effective:'managed', reason:'Managed settings prevent an override.' } });
  expect(html).toContain('Managed settings prevent an override.');
  expect(html).not.toContain('Replace it in this project only');
});
