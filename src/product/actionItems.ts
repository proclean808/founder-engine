// The founder's product: meeting notes -> action items with due dates.
import { matchedPhrase, parseDueDate } from "../adapters/chrono.js";

export interface ActionItem {
  text: string;
  owner: string | null;
  due: string | null;
  dueSource: string | null; // phrase the date came from
}

const ACTION_VERBS =
  /\b(follow up|send|draft|book|schedule|call|email|review|prepare|finish|ship|fix|write|update|share|confirm|set up|create|renew|pay|submit|plan)\b/i;
const BULLET = /^\s*(?:[-*•]|\d+[.)]|\[ \]|todo:?|action:?)\s*/i;

export function extractActionItems(notes: string, reference: Date = new Date()): ActionItem[] {
  return notes
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => BULLET.test(l) || ACTION_VERBS.test(l))
    .filter((l) => ACTION_VERBS.test(l))
    .map((raw) => {
      const text = raw.replace(BULLET, "").trim();
      const ownerMatch = text.match(/^@?([A-Z][a-z]+):\s*/) ?? text.match(/^@([A-Za-z]+)\s+/);
      const clean = ownerMatch ? text.slice(ownerMatch[0].length) : text;
      return {
        text: clean,
        owner: ownerMatch ? ownerMatch[1] : null,
        due: parseDueDate(clean, reference),
        dueSource: matchedPhrase(clean, reference),
      };
    });
}

export function toMarkdown(items: ActionItem[]): string {
  const rows = items.map((i) => `| ${i.text.replace(/\|/g, "\\|")} | ${i.owner ?? "—"} | ${i.due ?? "—"} |`);
  return ["| Action | Owner | Due |", "|---|---|---|", ...rows].join("\n");
}
