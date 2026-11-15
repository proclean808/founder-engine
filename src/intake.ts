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
export const CAPABILITY_RULES: CapabilityRule[] = [
  {
    capability: {
      id: "natural-language-date-parsing",
      description: "Turn phrases like 'next Friday' or 'by Nov 20' into concrete dates",
      searchQuery: "natural language date parser",
    },
    triggers: [/due date/i, /deadline/i, /\bdates?\b/i, /\bwhen\b.*\bdue\b/i, /schedul/i, /remind/i],
  },
  {
    capability: {
      id: "markdown-rendering",
      description: "Render Markdown notes to HTML",
      searchQuery: "markdown parser",
    },
    triggers: [/markdown/i],
  },
  {
    capability: {
      id: "schema-validation",
      description: "Validate structured data",
      searchQuery: "typescript schema validation",
    },
    triggers: [/validat/i, /\bschema\b/i],
  },
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
  if (/\bnon[- ]technical|can'?t code|no coding\b/i.test(text)) out.push("founder is non-technical");
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

export function intakeDeterministic(founderStatement: string): VentureSpec {
  const text = founderStatement.trim();
  const capabilities = CAPABILITY_RULES.filter((r) => r.triggers.some((t) => t.test(text))).map((r) => r.capability);
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
