import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { BridgeProvider } from '../../platform/BridgeContext';
import { createProjectFixtureBridge, createFixtureBridge } from '../../platform/fixtureBridge';
import { IdleIsland } from './IdleIsland';
import { deriveCompanionPresence } from './companionPresence';
import { islandPreviewActivity } from './islandActivity';
import { islandUsageSummary } from './IslandUsage';
import { IslandMode } from './IslandMode';
import { canonicalScript } from '../session/model/canonicalScript';
import { evaluateFrame } from '../session/model/evaluateFrame';
import { derivePresence } from './presence';
import type { ClaudeUsageState } from '../usage/claudeUsage';
vi.mock('react', async original => { const actual = await original<typeof import('react')>(); return { ...actual,
  useState: (initial: unknown) => actual.useState(initial === false ? true : initial),
}; });
const now = Date.UTC(2026, 9, 8, 14);
const reading: ClaudeUsageState = { status:'reading', sourceCount:1, latest:{
  source:{kind:'claude-statusline',sessionId:'synthetic',projectId:'p'},receivedAtMs:now,
  fiveHour:{usedPercentage:24,resetsAtMs:null},sevenDay:{usedPercentage:68,resetsAtMs:null},
} };
const render = (usage:ClaudeUsageState) => {
  const bridge = { ...createProjectFixtureBridge(), claudeUsage:() => usage };
  return renderToStaticMarkup(createElement(BridgeProvider,{bridge, children:createElement(IdleIsland,{onOpen:()=>{},companion:deriveCompanionPresence({connected:true,available:true,facts:[]},now)})}));
};
it('orders identity, one activity line, compact usage and the existing three actions', () => {
  const html = render(reading);
  expect(html).toContain('class="island__identity"');
  expect(html.indexOf('island__identity')).toBeLessThan(html.indexOf('island__activity'));
  expect(html.indexOf('island__activity')).toBeLessThan(html.indexOf('usage-rings--compact'));
  expect(html.indexOf('usage-rings--compact')).toBeLessThan(html.indexOf('island__actions'));
  expect(html).toContain('5h 24% · week 68% used');
  expect(html.match(/No agent active right now\./g)).toHaveLength(2); // text + its title, one activity element
  expect(html.match(/class="island__activity"/g)).toHaveLength(1);
  for (const action of ['Open Mini Player','Open window','Give Raio a cookie']) expect(html).toContain(`aria-label="${action}"`);
});
it('hides opted-out usage and never turns missing or expired windows into zero', () => {
  expect(render({status:'disabled'})).not.toContain('usage-rings');
  expect(render({status:'waiting'})).toContain('Usage unavailable');
  const partial = { ...reading, latest:{...reading.latest, fiveHour:{usedPercentage:0,resetsAtMs:null},sevenDay:undefined} };
  expect(render(partial)).toContain('5h 0% · week — used');
});
it('marks observations as last activity with a time and source even during the recent-activity mood', () => {
  const facts = [{id:'a',kind:'activity' as const,at:now,source:'Claude hook'}];
  const companion = deriveCompanionPresence({connected:true,available:true,facts},now,'UTC');
  expect(islandPreviewActivity(companion,facts,now,'UTC')).toBe('Last activity · 14:00 · Activity observed · Claude hook');
  expect(islandPreviewActivity(companion,[],now,'UTC')).toBe('Activity details unavailable');
});
it('usage cannot change the factual dot or character mood', () => {
  const html = render(reading);
  expect(html).toContain('data-character-mode="idle"'); expect(html).toContain('data-presence="connected"');
  expect(html).not.toContain('data-presence="failure"');
  expect(createFixtureBridge(null).claudeUsage?.()).toEqual({status:'disabled'});
});
it('renders the shared compact rings in the session path with the same hierarchy and real state', () => {
  const base = createFixtureBridge(), snapshot = base.currentSession()!;
  const frame = evaluateFrame(canonicalScript,snapshot.graph,4);
  const html = renderToStaticMarkup(createElement(BridgeProvider,{bridge:{...base,claudeUsage:()=>reading},children:createElement(IslandMode,{
    script:canonicalScript,frame,presence:derivePresence(canonicalScript,snapshot.graph,frame,false),
    companion:deriveCompanionPresence({connected:true,available:true,facts:[]},now),onPinMini:()=>{},onExpand:()=>{},onViewChanges:()=>{},
  })}));
  expect(html).toContain('acme-web · Claude Code'); expect(html).toContain('Last activity');
  expect(html).toContain('5h 24% · week 68% used'); expect(html).toContain('data-presence="connected"');
  expect(html.indexOf('island__activity')).toBeLessThan(html.indexOf('usage-rings--compact'));
});
it('keeps true zero and stale readings distinct from independently missing or expired windows', () => {
  expect(islandUsageSummary(reading,now+20*60_000)).toBe('5h 24% · week 68% used');
  expect(islandUsageSummary({...reading,latest:{...reading.latest,fiveHour:{usedPercentage:0,resetsAtMs:null},sevenDay:{usedPercentage:68,resetsAtMs:now}}},now)).toBe('5h 0% · week — used');
  expect(islandUsageSummary({...reading,latest:{...reading.latest,fiveHour:undefined,sevenDay:{usedPercentage:68,resetsAtMs:now}}},now)).toBe('Usage unavailable');
  for (const state of [{status:'waiting'},{status:'error',reason:'Unavailable'},{status:'incompatible',reason:'Existing status line'}] as const) {
    expect(render(state)).toContain('Usage unavailable'); expect(render(state)).not.toContain('stroke-dasharray');
  }
});
it('keeps disconnected and unknown previews honest even if an older fact is available', () => {
  const facts = [{id:'a',kind:'activity' as const,at:now,source:'Claude hook'}];
  for (const [connected,available,expected] of [[false,true,'Choose a project to connect'],[true,false,'Activity status unavailable']] as const) {
    const companion=deriveCompanionPresence({connected,available,facts},now);
    expect(islandPreviewActivity(companion,facts,now,'UTC','Read file · 14:00')).toBe(expected);
  }
});
