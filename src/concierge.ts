// Founder Concierge: the voice-first front door. A native speech-to-speech session (same live
// providers as the pitch room) that helps the founder define a venture and drives the engine
// through tools. It never claims a result the engine did not return.
import { intakeDeterministic, intakeWithProvider } from "./intake.js";
import { providerFromEnv } from "./provider.js";
import { LIVE_PROVIDERS, mintSession, type LiveProviderId } from "./live.js";
import type { VentureSpec } from "./types.js";

export const CONCIERGE_TOOLS = [
  { name: "define_venture", description: "Record the venture once you understand it. Call with the founder's idea in their own words: the problem, who it is for, and the outcome they want.", parameters: { type: "object", properties: { statement: { type: "string", description: "One paragraph in the founder's words." } }, required: ["statement"] } },
  { name: "find_slices", description: "Search open-source components for this venture, vet their provenance and licences, integrate the best fit and run its acceptance test. Takes up to a minute; tell the founder it is running.", parameters: { type: "object", properties: {} } },
  { name: "get_status", description: "Get the current venture's status: definition, components, build and test results.", parameters: { type: "object", properties: {} } },
  { name: "open_section", description: "Show a section of the workspace on screen.", parameters: { type: "object", properties: { section: { type: "string", enum: ["workspace", "ventures", "openslice", "build", "pitch", "evidence", "settings"] } }, required: ["section"] } },
];

export const CONCIERGE_INSTRUCTIONS = [
  "You are the Founder Concierge for PlatFormula.One, a voice-first venture studio. You are an AI; say so if asked.",
  "Talk like a sharp, warm co-founder on a call: short turns, one question at a time.",
  "Your job: understand what the founder wants to build (the problem, who it is for, the outcome), then call define_venture with their idea in their own words.",
  "Then offer to find the open-source building blocks: call find_slices. While it runs, say it is vetting components and running tests.",
  "Report only what the tools return: component names, licences, test results. Never invent results, numbers or progress. If a tool fails, say so plainly.",
  "Use open_section to show the founder what you are talking about. When the venture is ready, suggest the Pitch Studio.",
  "Never discuss offering, selling or pricing securities; that is for the founder and counsel.",
].join("\n");

export function conciergeProvider(env: NodeJS.ProcessEnv = process.env): LiveProviderId | null {
  const want = env.FE_CONCIERGE_PROVIDER as LiveProviderId | undefined;
  if (want && LIVE_PROVIDERS[want] && env[LIVE_PROVIDERS[want].key]) return want;
  for (const id of ["gemini", "openai", "grok"] as LiveProviderId[]) if (env[LIVE_PROVIDERS[id].key]) return id;
  return null;
}

export function conciergeStatus(env: NodeJS.ProcessEnv = process.env) {
  const p = conciergeProvider(env);
  return { ready: Boolean(p), provider: p, name: p ? LIVE_PROVIDERS[p].name : null, needs: p ? [] : ["GEMINI_API_KEY or OPENAI_API_KEY or XAI_API_KEY"] };
}

export async function conciergeSession(context: string | null, env: NodeJS.ProcessEnv = process.env) {
  const p = conciergeProvider(env);
  if (!p) throw new Error("No voice model key is set. Add GEMINI_API_KEY, OPENAI_API_KEY or XAI_API_KEY in Vercel.");
  const instructions = context ? `${CONCIERGE_INSTRUCTIONS}\nCurrent venture (from the workspace record):\n${context.slice(0, 4000)}` : CONCIERGE_INSTRUCTIONS;
  return mintSession(p, { instructions, tools: CONCIERGE_TOOLS }, undefined, env);
}

/** Turn the founder's spoken idea into a structured venture spec. Uses the configured text model if any, else deterministic rules. */
export async function defineVenture(statement: string): Promise<VentureSpec> {
  const provider = providerFromEnv();
  if (provider) {
    try { return await intakeWithProvider(statement, provider); } catch { /* fall through to rules; the spec records which method ran */ }
  }
  return intakeDeterministic(statement);
}
