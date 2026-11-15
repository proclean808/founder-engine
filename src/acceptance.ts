// Executable acceptance test for the integrated component.
// Expected values are derived from the calendar (reference date Sun 2026-11-15 UTC),
// not from the component's own output.
import type { AcceptanceCase, AcceptanceResult } from "./types.js";
import { parseDueDate } from "./adapters/chrono.js";

export const REFERENCE_DATE = "2026-11-15T12:00:00Z"; // a Sunday

export const CHRONO_CASES: AcceptanceCase[] = [
  { id: "relative-weekday", input: "Follow up with Dana next Friday", referenceDate: REFERENCE_DATE, expectedDate: "2026-11-20" },
  { id: "absolute-month-day", input: "Send the deck by November 20", referenceDate: REFERENCE_DATE, expectedDate: "2026-11-20" },
  { id: "tomorrow", input: "Book the venue tomorrow", referenceDate: REFERENCE_DATE, expectedDate: "2026-11-16" },
  { id: "in-n-days", input: "Draft budget in 3 days", referenceDate: REFERENCE_DATE, expectedDate: "2026-11-18" },
  { id: "iso-date", input: "Contract renewal on 2026-12-01", referenceDate: REFERENCE_DATE, expectedDate: "2026-12-01" },
  { id: "month-day-time", input: "Investor call Dec 3 at 3pm", referenceDate: REFERENCE_DATE, expectedDate: "2026-12-03" },
  { id: "no-date", input: "Think about pricing tiers", referenceDate: REFERENCE_DATE, expectedDate: null },
];

export function runChronoAcceptance(cases: AcceptanceCase[] = CHRONO_CASES): AcceptanceResult[] {
  return cases.map((c) => {
    let actual: string | null;
    try {
      actual = parseDueDate(c.input, new Date(c.referenceDate));
    } catch (e) {
      actual = `ERROR: ${(e as Error).message}`;
    }
    return { caseId: c.id, input: c.input, expected: c.expectedDate, actual, pass: actual === c.expectedDate };
  });
}
