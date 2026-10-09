/** Keep the visual fixture's observer from observing its own unchanged label writes. */
export const syncShownProjects = (
  shown: string[],
  name: string | undefined,
  output: { textContent: string | null } | null,
): void => {
  if (name && shown.at(-1) !== name) shown.push(name);
  const next = shown.join(' | ') || 'none';
  if (output && output.textContent !== next) output.textContent = next;
};

/** Keep settings-write proof separate from the project-name tracker output. */
export const syncSettingsWriteCount = (host: Pick<HTMLElement, 'querySelector'>, writes: number): void => {
  const output = host.querySelector<HTMLOutputElement>('[aria-label="Settings writes"]');
  const next = String(writes);
  if (output && output.textContent !== next) output.textContent = next;
};
