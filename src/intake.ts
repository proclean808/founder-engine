// Founder intake: plain-language idea -> structured VentureSpec.
// Two extraction paths, recorded in spec.extraction_method:
//  - deterministic-rules: keyword rules below (default; reproducible, used in tests)
//  - llm-provider: structured extraction via an OpenAI-compatible provider (optional)

import type { Capability, VentureSpec } from "./types.js";
import type { ChatProvider } from "./provider.js";

interface CapabilityRule {
  capability: Capability;
  triggers: RegExp[];
}

// Capability catalogue. Each capability maps to a registry search query.
// Extend this as more component adapters are added.
const cap = (id: string, description: string, searchQuery: string, triggers: RegExp[]): CapabilityRule => ({
  capability: { id, description, searchQuery },
  triggers,
});

// Building-block catalogue. A founder intent usually decomposes into several of these slices;
// each maps to a registry search query. Extend as more component adapters are added.
export const CAPABILITY_RULES: CapabilityRule[] = [
  cap("natural-language-date-parsing", "Turn phrases like 'next Friday' or 'by Nov 20' into concrete dates", "natural language date parser",
    [/due date/i, /deadline/i, /\bdates?\b/i, /\bwhen\b.*\bdue\b/i, /schedul/i, /remind/i]),
  cap("pdf-generation", "Generate PDF documents", "pdf generation", [/\bpdfs?\b/i, /invoice/i, /printable/i]),
  cap("email-sending", "Send transactional email", "send email smtp", [/\be-?mails?\b/i, /newsletter/i, /notify by mail/i]),
  cap("csv-parsing", "Import and export CSV / spreadsheet data", "csv parser", [/\bcsv\b/i, /spreadsheet/i, /excel/i, /import (data|contacts|rows)/i]),
  cap("charts", "Render charts and data visualisations", "javascript charting library", [/\bcharts?\b/i, /\bgraphs?\b/i, /dashboard/i, /visuali[sz]/i]),
  cap("fuzzy-search", "Fast in-app fuzzy search", "fuzzy search", [/search/i, /\bfind\b.*\bquickly\b/i, /lookup/i, /directory/i]),
  cap("markdown-rendering", "Render Markdown notes to HTML", "markdown parser", [/markdown/i, /\bnotes?\b.*\bformat/i]),
  cap("schema-validation", "Validate structured data", "typescript schema validation", [/validat/i, /\bschema\b/i, /\bforms?\b/i]),
  cap("qr-codes", "Generate QR codes", "qr code generator", [/\bqr\b/i]),
  cap("payments", "Accept payments", "stripe", [/payment/i, /\bcharge\b/i, /checkout/i, /subscription/i, /billing/i]),
  cap("currency-money", "Exact money and currency arithmetic", "money currency arithmetic", [/currenc/i, /\bmoney\b/i, /\btax(es)?\b/i, /invoice/i]),
  cap("unique-ids", "Generate unique IDs", "unique id generator", [/\bids?\b/i, /invoice numbers?/i, /tracking numbers?/i]),
];

function detectStage(text: string): VentureSpec["stage"] {
  if (/\b(revenue|customers|paying|operating|launched)\b/i.test(text)) return "operating";
  if (/\b(prototype|mvp|beta|built a|working version)\b/i.test(text)) return "prototype";
  if (/\b(idea|want to|would like to|thinking about|i want)\b/i.test(text)) return "idea";
  return "unknown";
}

function detectTargetUser(text: string): string | null {
  const m = text.match(/\bfor ([a-z][a-z \-]{2,60}?)(?:[.,;]| who| that| to|$)/i);
  return m ? m[1].trim() : null;
}

function detectConstraints(text: string): string[] {
  const out: string[] = [];
  if (/\b(no|without) (a )?(server|backend)\b/i.test(text)) out.push("no server/backend");
  if (/\b(offline|local[- ]first)\b/i.test(text)) out.push("local-first / offline");
  if (/\bfree|bootstrapp|no budget|cheap\b/i.test(text)) out.push("minimal budget");
  if (/\bnon[- ]technical|can'?t code|cannot code|no coding\b/i.test(text)) out.push("founder is non-technical");
  return out;
}

function ventureName(text: string): string {
  const named = text.match(/\bcalled ["“']?([A-Z][\w\- ]{1,40}?)["”']?(?:[.,]|$| that| which)/);
  if (named) return named[1].trim();
  const words = text
    .replace(/[^a-z ]/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length > 4 && !/^(would|about|thinking|something|their|there|which|tool|these)$/i.test(w))
    .slice(0, 3);
  return words.length ? words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ") : "Untitled Venture";
}

const STOPWORDS = new Set(
  ("about after again also because been before being build could does doing each from have having here into just like make " +
    "more most much need only other over same should some something such than that their them then there these they thing " +
    "this those through tool very want what when where which while will with would your idea people really able small").split(" "),
);

/** Fallback for intents outside the catalogue: derive a registry search query from content words. */
export function deriveCapability(text: string): Capability | null {
  const words = (text.toLowerCase().match(/[a-z][a-z\-]{3,}/g) ?? []).filter((w) => !STOPWORDS.has(w));
  const counts = new Map<string, number>();
  words.forEach((w, i) => counts.set(w, (counts.get(w) ?? 0) + 1 + 1 / (i + 10)));
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w);
  if (top.length < 2) return null;
  return { id: `derived:${top.join("-")}`, description: `Derived from founder intent: ${top.join(", ")}`, searchQuery: top.join(" ") };
}

export function intakeDeterministic(founderStatement: string): VentureSpec {
  const text = founderStatement.trim();
  const capabilities = CAPABILITY_RULES.filter((r) => r.triggers.some((t) => t.test(text))).map((r) => r.capability);
  if (capabilities.length === 0) {
    const derived = deriveCapability(text);
    if (derived) capabilities.push(derived);
  }
  const target_user = detectTargetUser(text);
  const open_questions: string[] = [];
  if (!target_user) open_questions.push("Who is the primary user?");
  if (capabilities.length === 0) open_questions.push("What is the single most important thing the product must do?");
  open_questions.push("What already exists (code, prototype, data) versus what must be built?");
  open_questions.push("Which AI model / development environment do you prefer?");
  const firstSentence = text.split(/(?<=[.!?])\s/)[0];
  return {
    schema_version: "1.0.0",
    venture_name: ventureName(text),
    founder_statement: text,
    problem: firstSentence,
    target_user,
    stage: detectStage(text),
    capabilities,
    constraints: detectConstraints(text),
    immediate_objective:
      capabilities.length > 0
        ? `Working tool demonstrating: ${capabilities.map((c) => c.description).join("; ")}`
        : "Clarify the core capability before building",
    open_questions,
    extraction_method: "deterministic-rules",
  };
}

/**
 * LLM-assisted intake. The provider proposes fields; capabilities are still
 * constrained to the catalogue so discovery stays deterministic and auditable.
 */
export async function intakeWithProvider(founderStatement: string, provider: ChatProvider): Promise<VentureSpec> {
  const base = intakeDeterministic(founderStatement);
  const ids = CAPABILITY_RULES.map((r) => r.capability.id);
  const reply = await provider.chat([
    {
      role: "system",
      content:
        "Extract a venture spec as JSON with keys venture_name, problem, target_user, stage (idea|prototype|operating|unknown), " +
        `constraints (string[]), capability_ids (subset of ${JSON.stringify(ids)}). Output JSON only. Do not invent facts.`,
    },
    { role: "user", content: founderStatement },
  ]);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(reply.replace(/^```(json)?|```$/g, "").trim());
  } catch {
    return base; // fail closed to deterministic extraction
  }
  const capIds = Array.isArray(parsed.capability_ids) ? (parsed.capability_ids as string[]) : [];
  const caps = CAPABILITY_RULES.filter((r) => capIds.includes(r.capability.id)).map((r) => r.capability);
  const stage = ["idea", "prototype", "operating", "unknown"].includes(String(parsed.stage))
    ? (parsed.stage as VentureSpec["stage"])
    : base.stage;
  return {
    ...base,
    venture_name: typeof parsed.venture_name === "string" ? parsed.venture_name : base.venture_name,
    problem: typeof parsed.problem === "string" ? parsed.problem : base.problem,
    target_user: typeof parsed.target_user === "string" ? parsed.target_user : base.target_user,
    stage,
    constraints: Array.isArray(parsed.constraints) ? (parsed.constraints as string[]) : base.constraints,
    capabilities: caps.length ? caps : base.capabilities,
    extraction_method: "llm-provider",
  };
}
