/** Native and browser hover share this lifetime; no polling and at most one exit timer. */
export const createIslandHover = (setOpen: (open: boolean) => void) => {
  let pointer = false;
  let focused = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const change = (inside: boolean, previous: boolean) => {
    if (inside) {
      cancel();
      if (!previous) setOpen(true);
    } else if (previous && !pointer && !focused && timer === undefined) {
      timer = setTimeout(() => { timer = undefined; if (!disposed) setOpen(false); }, 250);
    }
  };
  return {
    pointer: (inside: boolean) => { if (disposed) return; const previous = pointer; pointer = inside; change(inside, previous); },
    focus: (inside: boolean) => { if (disposed) return; const previous = focused; focused = inside; change(inside, previous); },
    escape: () => { if (!disposed) { cancel(); setOpen(false); } },
    dispose: () => { disposed = true; cancel(); setOpen(false); },
  };
};

/** An async native registration may finish after the surface was hidden or replaced. */
export const followIslandPointer = (
  listen: (handler: (inside: boolean) => void) => Promise<() => void>,
  update: (inside: boolean) => void,
): (() => void) => {
  let disposed = false;
  let stop: (() => void) | undefined;
  void listen(inside => { if (!disposed) update(inside); }).then(unlisten => {
    if (disposed) unlisten(); else stop = unlisten;
  }).catch(error => { if (!disposed) console.warn('Raio Island pointer unavailable', error); });
  return () => { disposed = true; stop?.(); };
};
