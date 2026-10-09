import type { DesktopBridge } from './desktopBridge';

export const PROJECT_INTENT_WAIT_MS = 5_000;

/** A fixed Expanded surface with intent APIs must wait for its launch-time folder intent. */
export const shouldGateForProjectIntent = (bridge: DesktopBridge): boolean =>
  bridge.fixedSurface === 'expanded'
  && (typeof bridge.takeProjectIntent === 'function' || typeof bridge.onProjectIntent === 'function');

const rootKey = (root: string, windows: boolean): string => {
  let key = windows ? root.replaceAll('\\', '/').toLowerCase() : root;
  if (windows) key = key.replace(/^\/\/\?\/unc\//, '//').replace(/^\/\/\?\//, '');
  // Dot components are lexical aliases; never resolve parent components across a possible symlink.
  const normalized = key.replace(/\/\.(?=\/|$)/g, '');
  key = normalized || (key.startsWith('/') ? '/' : '');
  return key.length > 1 ? key.replace(/\/+$/, '') : key;
};
export const sameProjectRoot = (a: string, b: string, windows: boolean): boolean => rootKey(a, windows) === rootKey(b, windows);
export const isWindowsRoot = (root: string): boolean => /^[a-z]:[\\/]|^\\\\|^\/\//i.test(root);

/** Listen before taking the startup value; a newer event wins, and all callbacks stop on unmount. */
export const followProjectIntents = (bridge: DesktopBridge, receive: (root: string) => void | boolean | Promise<void | boolean>, ready?: () => void): (() => void) => {
  let active = true;
  let eventArrived = false;
  let stop: (() => void) | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  const markReady = () => {
    if (!active) return;
    if (readyTimer !== undefined) clearTimeout(readyTimer);
    readyTimer = undefined;
    ready?.();
  };
  readyTimer = setTimeout(markReady, PROJECT_INTENT_WAIT_MS);
  const deliver = async (root: string) => {
    if (!active || !root) return;
    const accepted = await receive(root);
    if (accepted !== false) markReady();
  };
  const take = () => {
    if (!bridge.takeProjectIntent) { markReady(); return; }
    void Promise.resolve().then(() => bridge.takeProjectIntent!()).then(async (root) => {
      if (active && !eventArrived && typeof root === 'string' && root) await deliver(root);
      else if (!eventArrived) markReady();
    }).catch(() => markReady());
  };
  let subscription: Promise<() => void> | undefined;
  try { subscription = bridge.onProjectIntent?.((root) => {
    if (!active || !root) return;
    eventArrived = true;
    void deliver(root);
  }); } catch { subscription = undefined; }
  if (subscription) void Promise.resolve(subscription).then((unlisten) => {
    if (!active) { unlisten(); return; }
    stop = unlisten;
    take();
  }).catch(() => { if (active) take(); });
  else take();
  return () => { active = false; if (readyTimer !== undefined) clearTimeout(readyTimer); stop?.(); };
};
