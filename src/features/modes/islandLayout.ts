/** Observe natural preview layout, never the animated capsule box (which would feed back on itself). */
export const observeIslandPreviewHeight = (capsule: HTMLElement): (() => void) => {
  const preview = capsule.querySelector<HTMLElement>('.island__preview');
  const body = capsule.querySelector<HTMLElement>('.island__content-body');
  const actions = capsule.querySelector<HTMLElement>('.island__actions');
  if (!preview || !body || !actions) return () => {};
  let alive = true;
  const measure = () => {
    if (!alive) return;
    const padding = parseFloat(getComputedStyle(preview).paddingBottom) || 0;
    capsule.style.setProperty('--island-open-height', `${Math.max(144, Math.ceil(preview.offsetTop + body.offsetHeight + actions.offsetHeight + padding + 2))}px`);
  };
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(body);
  observer.observe(actions);
  void document.fonts.ready.then(measure);
  return () => { alive = false; observer.disconnect(); };
};
