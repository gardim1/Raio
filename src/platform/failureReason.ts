/** Display a bounded failure reason without exposing private machine paths or exception stacks. */
export const failureReason = (error: unknown): string | undefined => {
  const text = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  const starts = /file:\/\/\/?(?:[a-z]:)?|[a-z]:[\\/]|\\\\|(?<![\p{L}\p{N}_/\\])[\/]/giu;
  let redacted = '', cursor = 0;
  for (const match of text.matchAll(starts)) {
    const start = match.index;
    if (start < cursor) continue;
    const bodyStart = start + match[0].length;
    const delimiter = text.slice(bodyStart).search(/:(?=\s|$)|[\r\n]/);
    let end = delimiter < 0 ? text.length : bodyStart + delimiter;
    const quote = text[start - 1];
    if (quote === '"' || quote === "'") {
      for (let at = bodyStart; at < text.length; at++) {
        if (text[at] === quote && /^\s*(?::(?:\s|$)|$)/.test(text.slice(at + 1))) { end = at; break; }
      }
    }
    let punctuation = '';
    if (delimiter < 0 && quote !== '"' && quote !== "'") {
      while (end > bodyStart && /[.,;!?)]/.test(text[end - 1]!)) end--;
      if (end < text.length) punctuation = text[end]!;
    }
    redacted += text.slice(cursor, start) + '[folder]' + punctuation;
    cursor = delimiter < 0 && quote !== '"' && quote !== "'" ? text.length : end;
  }
  const reason = (redacted + text.slice(cursor)).trim();
  return !reason ? undefined : reason.length <= 240 ? reason : `${reason.slice(0, 239).trimEnd()}…`;
};
