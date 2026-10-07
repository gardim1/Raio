import type { DesktopBridge } from './desktopBridge';

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
export const followProjectIntents = (bridge: DesktopBridge, receive: (root: string) => void): (() => void) => {
  let active = true;
  let eventArrived = false;
  let stop: (() => void) | undefined;
  const subscription = bridge.onProjectIntent?.((root) => {
    if (!active || !root) return;
    eventArrived = true;
    receive(root);
  });
  const take = () => { void bridge.takeProjectIntent?.().then((root) => { if (active && !eventArrived && root) receive(root); }).catch(() => {}); };
  if (subscription) void subscription.then((unlisten) => {
    if (!active) { unlisten(); return; }
    stop = unlisten;
    take();
  }).catch(() => { if (active) take(); });
  else take();
  return () => { active = false; stop?.(); };
};
