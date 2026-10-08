import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IslandShell } from './IslandShell';
const hooks=vi.hoisted(()=>({open:false,settled:true,visible:true,effects:[] as Array<()=>void|(()=>void)>}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),
  useState:(initial:unknown)=>initial===false?[hooks.open,(value:boolean)=>{hooks.open=value;}]:initial===true?[hooks.settled,(value:boolean)=>{hooks.settled=value;}]:[initial,()=>{}],
  useRef:()=>({current:null}),useId:()=> 'fade-preview',useLayoutEffect:()=>{},
  useEffect:(setup:()=>void|(()=>void))=>{hooks.effects.push(setup);},
}));
vi.mock('../../platform/BridgeContext',()=>({useBridge:()=>({kind:'fixture'})}));
vi.mock('../../shared/motion/surfaceVisibility',()=>({useSurfaceVisible:()=>hooks.visible}));
const shell=()=>{hooks.effects=[]; return IslandShell({description:'Fixture',collapsed:'Capsule',children:'Activity',onPinMini:()=>{},onExpand:()=>{}}).props.children;};
const cookie=(root:ReturnType<typeof shell>)=>root.props.children[1].props.children[1].props.children[2];
beforeEach(()=>{hooks.open=false;hooks.settled=true;hooks.visible=true;vi.useFakeTimers();vi.stubGlobal('window',{matchMedia:()=>({matches:false})});});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it('retains inert closing visuals for the opacity exit, then unmounts usage/cookie',()=>{
  hooks.open=true; shell(); hooks.effects[0]!();
  hooks.open=false; const closing=shell(); const stop=hooks.effects[0]!();
  expect(closing.props['aria-expanded']).toBe(false); expect(closing.props.children[1].props.inert).toBe(true);
  expect(cookie(closing)).toBeTruthy();
  vi.advanceTimersByTime(199); expect(cookie(shell())).toBeTruthy();
  vi.advanceTimersByTime(1); expect(cookie(shell())).toBeFalsy();
  stop?.(); expect(vi.getTimerCount()).toBe(0);
});
it('cancels exit cleanup on re-entry, and hides without retaining a timer or content',()=>{
  hooks.open=true; shell(); hooks.effects[0]!(); hooks.open=false; shell(); const cancel=hooks.effects[0]!();
  vi.advanceTimersByTime(100); cancel?.(); hooks.open=true; shell(); hooks.effects[0]!();
  vi.advanceTimersByTime(200); expect(cookie(shell())).toBeTruthy();
  hooks.visible=false; expect(cookie(shell())).toBeFalsy(); hooks.effects[0]!();
  expect(hooks.settled).toBe(true); expect(vi.getTimerCount()).toBe(0);
});
it('reduced motion removes closing content immediately without a delayed cleanup',()=>{
  hooks.open=true; shell(); hooks.effects[0]!();
  vi.stubGlobal('window',{matchMedia:()=>({matches:true})}); hooks.open=false; shell(); hooks.effects[0]!();
  expect(cookie(shell())).toBeFalsy(); expect(vi.getTimerCount()).toBe(0);
});
