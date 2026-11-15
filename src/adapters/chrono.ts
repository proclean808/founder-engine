// Integration adapter for chrono-node (MIT, wanasit/chrono).
// The only file in the product that imports the component directly.
import * as chrono from "chrono-node";

export const COMPONENT = { name: "chrono-node", capability: "natural-language-date-parsing" } as const;

/** Return the first due date found in `text` as YYYY-MM-DD (UTC), or null. Dates are resolved forward. */
export function parseDueDate(text: string, reference: Date): string | null {
  const results = chrono.parse(text, { instant: reference, timezone: "UTC" }, { forwardDate: true });
  if (results.length === 0) return null;
  return results[0].start.date().toISOString().slice(0, 10);
}

/** Return the matched phrase so callers can show what was understood. */
export function matchedPhrase(text: string, reference: Date): string | null {
  const r = chrono.parse(text, { instant: reference, timezone: "UTC" }, { forwardDate: true });
  return r[0]?.text ?? null;
}
