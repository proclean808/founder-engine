// Native live room: each presenter is a native speech-to-speech session (OpenAI Realtime, Gemini Live,
// Grok Voice). No speech-to-text or text-to-speech anywhere: the model hears and speaks audio itself.
//
// FACE / HANDLER split (Double Agent pattern):
//   FACE    = the native voice model. Hears the investor, speaks, handles barge-in. Untrusted.
//   HANDLER = this engine. Owns facts, access, escalation and hand-offs, reached only through tools.
//   Sheriff = the live guard in the room: the model's own output transcript is checked as it streams;
//             an unsourced number or a restricted term cuts the answer off mid-sentence.
//
// API keys never leave the server: the browser gets a short-lived, single-session credential.
import { answerQuestion, buildFacts, buildScript, PERSONAS, type AccessLevel, type Fact, type Persona, type PitchPack } from "./pitch.js";

export type LiveProviderId = "openai" | "gemini" | "grok";

export interface LiveProvider {
  id: LiveProviderId;
  name: string;
  product: string;
  key: string;
  modelEnv: string;
  defaultModel: string; // documented model id; override with the env var
  voices: string[];
  transport: "webrtc" | "websocket";
  source: string;
}

export const LIVE_PROVIDERS: Record<LiveProviderId, LiveProvider> = {
  openai: { id: "openai", name: "ChatGPT voice", product: "OpenAI Realtime", key: "OPENAI_API_KEY", modelEnv: "FE_LIVE_OPENAI_MODEL", defaultModel: "gpt-realtime-2.1", voices: ["marin", "cedar"], transport: "webrtc", source: "https://developers.openai.com/api/docs/guides/realtime-webrtc" },
  gemini: { id: "gemini", name: "Gemini Live", product: "Gemini Live API, native audio", key: "GEMINI_API_KEY", modelEnv: "FE_LIVE_GEMINI_MODEL", defaultModel: "gemini-3.1-flash-live-preview", voices: ["Kore", "Charon", "Puck"], transport: "websocket", source: "https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket" },
  grok: { id: "grok", name: "Grok Voice", product: "xAI Voice Agent API", key: "XAI_API_KEY", modelEnv: "FE_LIVE_GROK_MODEL", defaultModel: "grok-voice-latest", voices: ["eve", "ara", "rex"], transport: "websocket", source: "https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech" },
};

/** Default seating: one flagship native model per presenter. Override with FE_LIVE_SEATS="founder:grok,cto:gemini,cfo:openai". */
export function seats(env: NodeJS.ProcessEnv = process.env): Record<Persona, LiveProviderId> {
  const out: Record<Persona, LiveProviderId> = { founder: "grok", cto: "gemini", cfo: "openai" };
  for (const pair of (env.FE_LIVE_SEATS ?? "").split(",")) {
    const [p, v] = pair.split(":").map((s) => s?.trim());
    if (p in PERSONAS && v in LIVE_PROVIDERS) out[p as Persona] = v as LiveProviderId;
  }
  return out;
}

export function liveStatus(env: NodeJS.ProcessEnv = process.env) {
  const s = seats(env);
  const providers = Object.values(LIVE_PROVIDERS).map((p) => ({ id: p.id, name: p.name, product: p.product, configured: Boolean(env[p.key]), missing: env[p.key] ? [] : [p.key], model: env[p.modelEnv] ?? p.defaultModel, transport: p.transport, source: p.source }));
  const seatList = (Object.keys(s) as Persona[]).map((persona) => ({ persona, title: PERSONAS[persona].title, provider: s[persona], ready: Boolean(env[LIVE_PROVIDERS[s[persona]].key]) }));
  return { providers, seats: seatList, ready: seatList.every((x) => x.ready) };
}

// ---------------------------------------------------------------- what each presenter is told

const NUM = /\d[\d,]*(?:\.\d+)?%?/g;

/** Numbers a presenter may say: only those that appear in the facts it was given. */
export function allowedNumbers(facts: Fact[]): string[] {
  return [...new Set((facts.map((f) => f.text).join(" ").match(NUM) ?? []).map((n) => n.replace(/,/g, "").replace(/%$/, "")))];
}

/** Words that only occur in restricted facts; if they are ever spoken to a non-accredited viewer, the guard cuts in. */
export function restrictedTerms(pack: PitchPack): string[] {
  const all = buildFacts(pack, "accredited");
  const publicText = all.filter((f) => !f.restricted).map((f) => f.text.toLowerCase()).join(" ");
  const terms = new Set<string>();
  for (const f of all.filter((x) => x.restricted)) for (const w of f.text.toLowerCase().match(/[a-z][a-z-]{5,}/g) ?? []) if (!publicText.includes(w)) terms.add(w);
  return [...terms];
}

export const LIVE_TOOLS = [
  { name: "get_evidence", description: "Look up the approved venture facts that answer the investor's question. Call this before answering any factual question.", parameters: { type: "object", properties: { question: { type: "string", description: "The investor's question in their words." } }, required: ["question"] } },
  { name: "hand_off", description: "Give the floor to another presenter: founder (vision, customer, the ask), cto (technology, components, evidence), cfo (business model, money). Use it when your section is finished or when a question belongs to them.", parameters: { type: "object", properties: { to: { type: "string", enum: ["founder", "cto", "cfo"] }, question: { type: "string", description: "The investor question they should answer, if any." } }, required: ["to"] } },
  { name: "escalate_to_founder", description: "Record a question the approved facts do not cover, so the human founder answers it personally.", parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } },
  { name: "show_scene", description: "Advance the on-screen walkthrough to the scene you are talking about.", parameters: { type: "object", properties: { section: { type: "string" } }, required: ["section"] } },
];

export function presenterBrief(pack: PitchPack, persona: Persona, access: AccessLevel, opts: { includeRestricted?: boolean } = {}) {
  const level: AccessLevel = access === "accredited" && opts.includeRestricted ? "accredited" : access === "accredited" ? "identified" : access;
  const deck = buildScript(pack, { access: level });
  const facts = deck.facts;
  const mine = deck.script.filter((l) => l.persona === persona);
  const sections = [...new Set(mine.map((l) => l.section))];
  const next: Record<Persona, Persona | null> = { founder: "cto", cto: "cfo", cfo: "founder" };
  const instructions = [
    `You are the ${PERSONAS[persona].title} presenting ${deck.title} to an investor in a live voice conversation. ${PERSONAS[persona].role}`,
    "You are a synthetic AI presenter; say so if asked. Speak naturally and briefly, like a sharp founder on a call. One idea at a time.",
    "Rules you never break:",
    "- State only what the FACTS below or the get_evidence tool give you. Never invent results, customers, metrics or plans.",
    "- Never say a number unless it appears in those facts. No estimates, no rounding into new figures.",
    "- If the facts do not answer a question, say so plainly, call escalate_to_founder, and tell the investor the founder will answer personally.",
    "- If a question belongs to another presenter, call hand_off with their role and the question.",
    "- Do not give investment advice and do not discuss terms, pricing of securities or how to invest; those go to the founder.",
    "- Stop the moment the investor speaks, then answer them.",
    sections.length ? `Your part of the pitch covers: ${sections.join(", ")}. Talking points, in order:` : "You have no scripted section; answer questions in your area.",
    ...mine.map((l) => `- [${l.section}] ${l.text.replace(/\s*\[F\d+\]/g, "")}`),
    persona === "founder" ? "Open the pitch. When your opening is done, call hand_off to cto." : next[persona] ? `When your part is finished, call hand_off to ${next[persona]}.` : "",
    persona === "founder" ? "At the very end, close with the ask and invite questions." : "",
    "FACTS (id, text):",
    ...facts.map((f) => `${f.id}: ${f.text}`),
  ].filter(Boolean).join("\n");
  return { persona, instructions, facts_hash: deck.facts_hash, allowed_numbers: allowedNumbers(facts), restricted_terms: level === "accredited" ? [] : restrictedTerms(pack), sections, tools: LIVE_TOOLS };
}

// ---------------------------------------------------------------- the engine behind the tools

export async function runTool(pack: PitchPack, access: AccessLevel, name: string, args: Record<string, unknown>) {
  const q = String(args.question ?? "").slice(0, 500);
  switch (name) {
    case "get_evidence": {
      const a = await answerQuestion(pack, q || "overview", null, undefined, access);
      return a.escalate
        ? { covered: false, route: a.persona, instruction: "No approved fact covers this. Say so, call escalate_to_founder, and do not guess." }
        : { covered: true, route: a.persona, facts: a.cites.map((id) => buildFacts(pack, access).find((f) => f.id === id)).filter(Boolean).map((f) => ({ id: f!.id, text: f!.text, source: f!.source })), instruction: "Answer only from these facts. If route names another presenter, call hand_off to them with the question." };
    }
    case "hand_off": {
      const to = String(args.to);
      if (!(to in PERSONAS)) return { ok: false, error: "to must be founder, cto or cfo" };
      return { ok: true, to, question: q || null };
    }
    case "escalate_to_founder":
      return { ok: true, recorded: q, say: "Tell the investor the founder will answer this personally." };
    case "show_scene":
      return { ok: true, section: String(args.section ?? "") };
    default:
      return { ok: false, error: `unknown tool ${name}` };
  }
}

// ---------------------------------------------------------------- short-lived session credentials

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export class LiveError extends Error {}

/** Mint a single-session credential for one presenter. The browser connects to the vendor directly with it. */
export async function mintSession(provider: LiveProviderId, brief: ReturnType<typeof presenterBrief>, voice: string | undefined, env: NodeJS.ProcessEnv = process.env, f: Fetch = fetch as unknown as Fetch) {
  const p = LIVE_PROVIDERS[provider];
  if (!p) throw new LiveError(`unknown live provider ${provider}`);
  const key = env[p.key];
  if (!key) throw new LiveError(`${p.name} is not configured (needs ${p.key})`);
  const model = env[p.modelEnv] ?? p.defaultModel;
  const v = voice && p.voices.includes(voice) ? voice : p.voices[0];

  if (provider === "openai") {
    const session = {
      type: "realtime",
      model,
      instructions: brief.instructions,
      audio: { output: { voice: v }, input: { turn_detection: { type: "server_vad" }, transcription: null } },
      tools: brief.tools.map((t) => ({ type: "function", ...t })),
    };
    const r = await f("https://api.openai.com/v1/realtime/client_secrets", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ expires_after: { anchor: "created_at", seconds: 120 }, session }) });
    if (!r.ok) throw new LiveError(`OpenAI returned HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = (await r.json()) as { value?: string; client_secret?: { value?: string } };
    const secret = j.value ?? j.client_secret?.value;
    if (!secret) throw new LiveError("OpenAI returned no client secret");
    return { provider, transport: p.transport, model, voice: v, secret, connect: "https://api.openai.com/v1/realtime/calls" };
  }
  if (provider === "grok") {
    const r = await f("https://api.x.ai/v1/realtime/client_secrets", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ expires_after: { seconds: 120 } }) });
    if (!r.ok) throw new LiveError(`xAI returned HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = (await r.json()) as { value?: string; client_secret?: { value?: string } };
    const secret = j.value ?? j.client_secret?.value;
    if (!secret) throw new LiveError("xAI returned no client secret");
    // The browser sends the session (instructions, voice, tools) itself, as the first message on the socket.
    return { provider, transport: p.transport, model, voice: v, secret, connect: `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(model)}`, session: { instructions: brief.instructions, voice: v, turn_detection: { type: "server_vad" }, tools: brief.tools.map((t) => ({ type: "function", ...t })) } };
  }
  // gemini
  const expire = new Date(Date.now() + 10 * 60_000).toISOString();
  const start = new Date(Date.now() + 60_000).toISOString();
  const r = await f("https://generativelanguage.googleapis.com/v1alpha/auth_tokens", { method: "POST", headers: { "x-goog-api-key": key, "content-type": "application/json" }, body: JSON.stringify({ uses: 1, expireTime: expire, newSessionExpireTime: start }) });
  if (!r.ok) throw new LiveError(`Gemini returned HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { name?: string };
  if (!j.name) throw new LiveError("Gemini returned no ephemeral token");
  return {
    provider, transport: p.transport, model, voice: v, secret: j.name,
    connect: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(j.name)}`,
    setup: {
      model: `models/${model}`,
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: v } } } },
      systemInstruction: { parts: [{ text: brief.instructions }] },
      tools: [{ functionDeclarations: brief.tools }],
      outputAudioTranscription: {},
    },
  };
}
