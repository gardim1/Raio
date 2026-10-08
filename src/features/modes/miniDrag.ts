/** The Mini's status mascot and its controls reserve their own gestures. */
export const canStartMiniDrag = (target: Pick<Element, 'closest'>, button: number): boolean =>
  button === 0 && !target.closest('button,.mini__status,.mini-orb');
