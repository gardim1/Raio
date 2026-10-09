/** Only contract-defined details become user copy; unknown details are never echoed. */
export const unknownResultText = (detail?: string, program?: string): string => {
  if (detail === 'did-not-start') return `Could not start ${program || 'the command'} — check did not run`;
  let reason: string;
  switch (detail) {
    case 'interrupted': reason = 'interrupted'; break;
    case 'background command': reason = 'ran in the background'; break;
    case 'compound command': reason = 'combined with other commands'; break;
    case 'result not established': reason = "tool result can't confirm it"; break;
    default: return 'result unknown';
  }
  return `result unknown · ${reason}`;
};
