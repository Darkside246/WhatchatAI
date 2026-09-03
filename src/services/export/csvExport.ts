/**
 * Section 67 (CRM Data Export) of the AURA master directive: a minimal,
 * dependency-free RFC 4180-style CSV writer - no new library for something
 * this small, consistent with this codebase's existing preference for
 * hand-rolled logic over a dependency where the real need is simple
 * (see conversationIntentClassifier.ts's own reasoning).
 */
export function toCsvRow(values: unknown[]): string {
  return values
    .map((value) => {
      if (value === null || value === undefined) return '';
      const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
      return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    })
    .join(',');
}

/** `columns` controls both field order and the header row - callers never accidentally emit an object's keys in an unstable order. */
export function toCsv<T extends Record<string, unknown>>(rows: T[], columns: { key: keyof T; header: string }[]): string {
  const header = toCsvRow(columns.map((c) => c.header));
  const lines = rows.map((row) => toCsvRow(columns.map((c) => row[c.key])));
  return [header, ...lines].join('\r\n');
}
