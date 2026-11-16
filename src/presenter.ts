// Modular presenter system. The engine is the brain; a presenter is only a face and a voice.
//
//   question -> engine (access, retrieval, validation, escalation) -> ApprovedUtterance (signed)
//            -> router (tier check, restricted-content policy, availability) -> voice -> face
//
// Invariants enforced here, independent of which vendor is selected:
//   1. A presenter only ever receives the text of a signed ApprovedUtterance. No vendor model writes words.
//   2. Every number in spoken text appears in the facts the utterance cites.
//   3. Restricted (IP) content is never planned for a viewer below "accredited", and is never sent to a
//      third-party face or voice unless the founder has explicitly allowed that provider.
//   4. A provider that is not configured, or whose live path is not built, is never presented as working:
//      the router falls back to the built-in presenter and says why.
import { createHmac, timingSafeEqual } from "node:crypto";
import { buildFacts, buildScript, factsHash, ungroundedNumbers, type AccessLevel, type Answer, type Fact, type InvestorLens, type Persona, type PitchPack, type ScriptLine } from "./pitch.js";

// ---------------------------------------------------------------- approved utterances

export interface ApprovedUtterance {
  v: 1;
  id: string; // "s3" for script line 3, "q:<hash>" for an answer
  kind: "script" | "answer";
  persona: Persona;
  speech: string; // exactly what the presenter may say (citation markers removed)
  cites: string[];
  restricted: boolean; // cites at least one founder-restricted fact
  facts_hash: string; // fact base this was approved against
  escalate: boolean;
  sig: string | null; // HMAC over everything above; null when no signing secret is configured
}

export const presenterSecret = (env: NodeJS.ProcessEnv = process.env): string | null => {
  const s = env.FE_PRESENTER_SECRET ?? env.FE_ACCESS_SECRET ?? "";
  return s.length >= 32 ? s : null;
};

const payloadOf = (u: Omit<ApprovedUtterance, "sig">) => JSON.stringify([u.v, u.id, u.kind, u.persona, u.speech, u.cites, u.restricted, u.facts_hash, u.escalate]);
const sign = (u: Omit<ApprovedUtterance, "sig">, secret: string) => createHmac("sha256", secret).update(payloadOf(u)).digest("base64url");

export function verifyUtterance(u: unknown, secret: string | null): u is ApprovedUtterance {
  if (!secret || !u || typeof u !== "object") return false;
  const x = u as ApprovedUtterance;
  if (x.v !== 1 || typeof x.speech !== "string" || !Array.isArray(x.cites) || typeof x.sig !== "string") return false;
  const expected = Buffer.from(sign(x, secret));
  const got = Buffer.from(x.sig);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export class ApprovalError extends Error {}

const stripCites = (t: string) => t.replace(/\s*\[F\d+\]/g, "").replace(/\s+/g, " ").trim();

/** Re-validate and sign. Throws if the text would put an ungrounded number in a presenter's mouth. */
function approve(base: Omit<ApprovedUtterance, "v" | "sig" | "restricted" | "facts_hash">, facts: Fact[], allFacts: Fact[], secret: string | null): ApprovedUtterance {
  const cited = facts.filter((f) => base.cites.includes(f.id));
  if (base.cites.length && cited.length !== base.cites.length) throw new ApprovalError(`${base.id}: cites facts outside the viewer's fact base`);
  if (!base.escalate) {
    if (!cited.length) throw new ApprovalError(`${base.id}: factual line without a citation`);
    const bad = ungroundedNumbers(base.speech, cited);
    if (bad.length) throw new ApprovalError(`${base.id}: ungrounded numbers ${bad.join(", ")}`);
  } else if (/\d/.test(base.speech)) {
    throw new ApprovalError(`${base.id}: an escalation must not speak numbers`);
  }
  const u: Omit<ApprovedUtterance, "sig"> = { v: 1, ...base, restricted: cited.some((f) => f.restricted), facts_hash: factsHash(allFacts) };
  return { ...u, sig: secret ? sign(u, secret) : null };
}

export function approveScript(pack: PitchPack, opts: { lens?: InvestorLens; access?: AccessLevel } = {}, secret = presenterSecret()) {
  const deck = buildScript(pack, opts);
  const utterances = deck.script.map((l: ScriptLine, i) => approve({ id: `s${i + 1}`, kind: "script", persona: l.persona, speech: stripCites(l.text), cites: l.cites, escalate: false }, deck.facts, deck.facts, secret));
  return { ...deck, utterances };
}

const ESCALATION_SPEECH: Record<Persona, string> = {
  cfo: "The founder hasn't given me figures for that, and I won't invent numbers. I've added your question to the founder's follow-up list.",
  cto: "There is no engineering evidence for that in this run. I've added your question to the founder's follow-up list.",
  founder: "That isn't covered by what the founder has told me. I've added your question to the founder's follow-up list.",
};

export function approveAnswer(pack: PitchPack, question: string, a: Answer, access: AccessLevel, secret = presenterSecret()): ApprovedUtterance {
  const facts = buildFacts(pack, access);
  const id = `q:${createHmac("sha256", "id").update(question).digest("hex").slice(0, 10)}`;
  // Escalations never echo the investor's words: a number in the question must not be spoken back as if sourced.
  const speech = a.escalate ? ESCALATION_SPEECH[a.persona] : stripCites(a.answer);
  return approve({ id, kind: "answer", persona: a.persona, speech, cites: a.escalate ? [] : a.cites, escalate: a.escalate }, facts, facts, secret);
}

// ---------------------------------------------------------------- provider registry

/** How we know a capability claim. Only "measured" comes from our own bake-off receipts. */
export type Evidence = "measured" | "documented" | "advertised" | "reported" | "not-published" | "limitation";

export interface Capability {
  value: string;
  evidence: Evidence;
  source?: string;
}

export type CapabilityKey = "exact_speech" | "interruption" | "latency" | "quality" | "cost" | "transport";

export interface ProviderSpec {
  id: string;
  kind: "face" | "voice";
  name: string;
  product: string;
  position: string; // why it is in the top three
  env: string[]; // configuration this deployment needs (names only; values never leave the server)
  live: "built" | "session-adapter" | "needs-livekit-worker" | "speech-adapter";
  live_note: string;
  caps: Partial<Record<CapabilityKey, Capability>>;
}

const SRC = {
  synthesiaApi: "https://www.synthesia.io/post/interactive-avatar-api-real-time-avatars",
  synthesiaDocs: "https://docs.synthesia.io/reference/interactive-avatars",
  synthesiaTransport: "https://dev.to/facemode/synthesia-interactive-avatar-vs-facemode-33g2",
  synthesiaPrice: "https://www.heygen.com/blog/best-real-time-ai-avatar-platforms",
  tavusEcho: "https://docs.tavus.io/sections/conversational-video-interface/echo-mode",
  tavusConv: "https://docs.tavus.io/api-reference/conversations",
  latencyStudy: "https://www.forasoft.com/learn/ai-for-video-engineering/articles-ai/real-time-avatar-lipsync-in-call",
  tavusPrice: "https://www.toughtongueai.com/blog/best-virtual-avatar-solutions-2026",
  liveAvatarLite: "https://docs.liveavatar.com/docs/lite-mode",
  liveAvatarStart: "https://docs.liveavatar.com/api-reference/sessions/start-session",
  liveAvatarInterrupt: "https://docs.liveavatar.com/discuss/69896e311ea3a755eab3f072",
  heygenPrice: "https://www.heygen.com/blog/best-real-time-ai-avatar-platforms",
  aaProvider: "https://artificialanalysis.ai/text-to-speech/leaderboard/provider-voice",
  aaControlled: "https://artificialanalysis.ai/text-to-speech/leaderboard/controlled-voice",
  aaSnapshot: "https://17nas.com/tts-leaderboard.php?lang=en-US",
  aaNov3: "https://www.teamday.ai/blog/best-ai-voice-models-2026",
  cartesiaLatency: "https://techstackups.com/comparisons/cartesia-vs-elevenlabs/",
  cartesiaPrice: "https://cartesia.ai/vs/cartesia-vs-hume",
};

export const PROVIDERS: ProviderSpec[] = [
  // ------------------------------------------------ faces
  {
    id: "native", kind: "face", name: "Built-in presenter", product: "founder-engine stage",
    position: "Always available; runs in the viewer's browser, so restricted content never leaves the session.",
    env: [], live: "built", live_note: "Works now.",
    caps: {
      exact_speech: { value: "Shows exactly the approved text", evidence: "documented" },
      interruption: { value: "Measured per run in the viewer's browser", evidence: "measured" },
      quality: { value: "Animated presenter cards, not photoreal video", evidence: "documented" },
      cost: { value: "No per-minute cost", evidence: "documented" },
      transport: { value: "None (in-page)", evidence: "documented" },
    },
  },
  {
    id: "synthesia", kind: "face", name: "Synthesia", product: "Interactive Avatar API (Express-3)",
    position: "Flagship photoreal tier. Bring-your-own-stack by design: we supply the words and the voice, Synthesia renders.",
    env: ["SYNTHESIA_API_KEY", "SYNTHESIA_AVATAR_ID", "LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"],
    live: "needs-livekit-worker", live_note: "Synthesia renders into a LiveKit room driven by a long-running agent worker; that worker is not built yet. Enterprise access required.",
    caps: {
      exact_speech: { value: "Customer supplies LLM and TTS; Synthesia renders the lip-synced avatar", evidence: "advertised", source: SRC.synthesiaApi },
      interruption: { value: "Advertised as interruptible", evidence: "advertised", source: SRC.synthesiaApi },
      latency: { value: "Not published", evidence: "not-published" },
      quality: { value: "Express-3 photoreal and Style avatars", evidence: "advertised", source: SRC.synthesiaApi },
      cost: { value: "Enterprise only; price not published", evidence: "not-published", source: SRC.synthesiaPrice },
      transport: { value: "LiveKit only", evidence: "reported", source: SRC.synthesiaTransport },
    },
  },
  {
    id: "tavus", kind: "face", name: "Tavus", product: "CVI with Phoenix replicas (Echo mode)",
    position: "Founder digital twin tier: a replica trained on the founder's own recorded video.",
    env: ["TAVUS_API_KEY", "TAVUS_REPLICA_ID", "TAVUS_PERSONA_ID"],
    live: "session-adapter", live_note: "Server creates the conversation (adapter built, not live-tested). Speaking requires the persona to be in Echo mode; the in-call echo channel is not wired yet.",
    caps: {
      exact_speech: { value: "Text Echo sends our text straight to TTS; Audio Echo streams our audio into the face", evidence: "documented", source: SRC.tavusEcho },
      interruption: { value: "Text Echo supports interrupt control", evidence: "documented", source: SRC.tavusEcho },
      latency: { value: "1.86 s median full-pipeline reply (competitor-run study)", evidence: "reported", source: SRC.latencyStudy },
      quality: { value: "Echo mode is incompatible with Tavus perception", evidence: "limitation", source: SRC.tavusEcho },
      cost: { value: "$0.26-0.35 per minute (third-party listing)", evidence: "reported", source: SRC.tavusPrice },
      transport: { value: "Daily WebRTC room (conversation_url)", evidence: "documented", source: SRC.tavusConv },
    },
  },
  {
    id: "heygen", kind: "face", name: "HeyGen LiveAvatar", product: "LiveAvatar, LITE mode",
    position: "Visual-polish tier: mature avatar library, our audio in, avatar video out.",
    env: ["LIVEAVATAR_API_KEY", "LIVEAVATAR_AVATAR_ID", "LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"],
    live: "needs-livekit-worker", live_note: "Session token and start calls are built (not live-tested); LITE mode needs our audio streamed in by a LiveKit worker, not built yet.",
    caps: {
      exact_speech: { value: "LITE mode renders video from the audio we send", evidence: "documented", source: SRC.liveAvatarLite },
      interruption: { value: "Developer report: LITE/custom mode lacks real-time interruption handling", evidence: "limitation", source: SRC.liveAvatarInterrupt },
      latency: { value: "1.82 s median full-pipeline reply (competitor-run study)", evidence: "reported", source: SRC.latencyStudy },
      quality: { value: "Large photoreal avatar library", evidence: "advertised", source: SRC.heygenPrice },
      cost: { value: "$389/month for 2,000 FULL-mode minutes (HeyGen's own blog)", evidence: "advertised", source: SRC.heygenPrice },
      transport: { value: "LiveKit room", evidence: "documented", source: SRC.liveAvatarStart },
    },
  },
  // ------------------------------------------------ voices
  {
    id: "native", kind: "voice", name: "Browser voice", product: "Web Speech API",
    position: "Always available, on-device; quality depends on the viewer's device.",
    env: [], live: "built", live_note: "Works now.",
    caps: {
      exact_speech: { value: "Speaks exactly the approved text", evidence: "documented" },
      interruption: { value: "Measured per run in the viewer's browser", evidence: "measured" },
      quality: { value: "Varies by device; not studio quality", evidence: "documented" },
      cost: { value: "No per-minute cost", evidence: "documented" },
    },
  },
  {
    id: "gemini", kind: "voice", name: "Gemini voices", product: "Gemini 3.1 Flash TTS",
    position: "One distinct voice per presenter from a single key; speaks the approved text exactly.",
    env: ["GEMINI_API_KEY"],
    live: "speech-adapter", live_note: "Server synthesis adapter built against the documented generateContent TTS call; not live-tested until a key is set.",
    caps: {
      exact_speech: { value: "Text-to-speech of the approved text (no model wording)", evidence: "documented", source: "https://ai.google.dev/gemini-api/docs/generate-content/speech-generation" },
      quality: { value: "Elo 1,211 on Artificial Analysis TTS leaderboard (reported)", evidence: "reported", source: "https://www.llmreference.com/provider/google-ai-studio/gemini-3.1-flash-tts-preview" },
      latency: { value: "Not yet measured by us", evidence: "not-published" },
      cost: { value: "$20 per 1M audio output tokens (reported)", evidence: "reported", source: "https://www.llmreference.com/provider/google-ai-studio/gemini-3.1-flash-tts-preview" },
    },
  },
  {
    id: "elevenlabs", kind: "voice", name: "ElevenLabs", product: "Eleven v4",
    position: "Top of the independent blind-preference leaderboard.",
    env: ["ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"],
    live: "speech-adapter", live_note: "Server synthesis adapter built, not live-tested. Model id defaults to eleven_v4 (set ELEVENLABS_MODEL_ID to override).",
    caps: {
      exact_speech: { value: "Text-to-speech of the approved text", evidence: "documented" },
      quality: { value: "#1 on Artificial Analysis provider-voice arena, Elo 1340 (15 Nov 2026 snapshot)", evidence: "reported", source: SRC.aaSnapshot },
      latency: { value: "Not yet measured by us", evidence: "not-published" },
      cost: { value: "$40 per 1M characters (Eleven v4 Turbo, Artificial Analysis)", evidence: "reported", source: SRC.aaControlled },
    },
  },
  {
    id: "cartesia", kind: "voice", name: "Cartesia", product: "Sonic 3.6",
    position: "Top-tier quality with the fastest first audio: best for live interruption.",
    env: ["CARTESIA_API_KEY", "CARTESIA_VOICE_ID"],
    live: "speech-adapter", live_note: "Server synthesis adapter built, not live-tested. Set CARTESIA_MODEL_ID to the exact Sonic 3.6 model id.",
    caps: {
      exact_speech: { value: "Text-to-speech of the approved text", evidence: "documented" },
      quality: { value: "Top-four on Artificial Analysis provider-voice arena (3 Nov 2026)", evidence: "reported", source: SRC.aaNov3 },
      latency: { value: "About 100 ms to first audio for Sonic 3.5 (third-party test)", evidence: "reported", source: SRC.cartesiaLatency },
      cost: { value: "$49 per 1M characters (Artificial Analysis, Aug 2026)", evidence: "reported", source: SRC.cartesiaPrice },
    },
  },
  {
    id: "inworld", kind: "voice", name: "Inworld", product: "TTS MAX / Realtime TTS-2",
    position: "#1 on the second major blind leaderboard (TTS Arena V2).",
    env: ["INWORLD_API_KEY", "INWORLD_VOICE_ID"],
    live: "speech-adapter", live_note: "Server synthesis adapter built, not live-tested. Set INWORLD_MODEL_ID to the exact model id.",
    caps: {
      exact_speech: { value: "Text-to-speech of the approved text", evidence: "documented" },
      quality: { value: "#1 on TTS Arena V2 (TTS MAX, Elo 1567)", evidence: "reported", source: SRC.aaSnapshot },
      latency: { value: "Not yet measured by us", evidence: "not-published" },
      cost: { value: "$20.83 per 1M characters (Realtime TTS-2, Artificial Analysis)", evidence: "reported", source: SRC.aaProvider },
    },
  },
];

export const EXPERIENCE_BENCHMARKS = [
  { name: "InteractPitch", why: "Closest all-in-one investor-pitch product; scored on experience only because it answers with its own model." },
  { name: "D-ID Presentation Mode", why: "Deck-led real-time agent with interruption; scored on experience only." },
];

export function provider(kind: "face" | "voice", id: string): ProviderSpec | undefined {
  return PROVIDERS.find((p) => p.kind === kind && p.id === id);
}

export interface ProviderStatus extends ProviderSpec {
  configured: boolean;
  missing: string[];
  available: boolean; // configured AND the live path is built
  restricted_ok: boolean;
  state: "ready" | "not-configured" | "configured-live-path-not-built";
}

export function providerStatus(p: ProviderSpec, env: NodeJS.ProcessEnv = process.env): ProviderStatus {
  const missing = p.env.filter((k) => !env[k]);
  const configured = missing.length === 0;
  const voiceReady = p.kind === "voice" && p.live === "speech-adapter"; // REST synthesis can run in a serverless function
  const available = configured && (p.live === "built" || voiceReady);
  const restricted_ok = p.id === "native" || env[`FE_PRESENTER_${p.id.toUpperCase()}_RESTRICTED_OK`] === "1";
  const state = available ? "ready" : !configured ? "not-configured" : "configured-live-path-not-built";
  return { ...p, configured, missing, available, restricted_ok, state };
}

export function listProviders(env: NodeJS.ProcessEnv = process.env) {
  return { faces: PROVIDERS.filter((p) => p.kind === "face").map((p) => providerStatus(p, env)), voices: PROVIDERS.filter((p) => p.kind === "voice").map((p) => providerStatus(p, env)), benchmarks: EXPERIENCE_BENCHMARKS, signing: presenterSecret(env) ? "configured" : "not configured: third-party presenters are refused" };
}

// ---------------------------------------------------------------- router

export interface DeliveryPlan {
  face: string;
  voice: string;
  fallbacks: string[]; // human-readable reasons a requested provider was not used
}

export class DeliveryRefused extends Error {}

const rank: Record<AccessLevel, number> = { public: 0, identified: 1, accredited: 2 };

export function planDelivery(u: ApprovedUtterance, viewer: AccessLevel, want: { face: string; voice: string }, env: NodeJS.ProcessEnv = process.env): DeliveryPlan {
  if (u.restricted && rank[viewer] < rank.accredited) throw new DeliveryRefused(`${u.id}: restricted content requested for a ${viewer} viewer`);
  const signed = verifyUtterance(u, presenterSecret(env));
  const fallbacks: string[] = [];
  const pick = (kind: "face" | "voice", id: string): string => {
    const spec = provider(kind, id);
    if (!spec) { fallbacks.push(`unknown ${kind} "${id}"`); return "native"; }
    if (id === "native") return id;
    const st = providerStatus(spec, env);
    if (!st.configured) { fallbacks.push(`${spec.name}: not configured (needs ${st.missing.join(", ")})`); return "native"; }
    if (!st.available) { fallbacks.push(`${spec.name}: ${spec.live_note}`); return "native"; }
    if (!signed) { fallbacks.push(`${spec.name}: signing secret not set on this deployment (FE_PRESENTER_SECRET), so nothing is sent to a third party`); return "native"; }
    if (u.restricted && !st.restricted_ok) { fallbacks.push(`${spec.name}: restricted content is not sent to a third-party ${kind} unless the founder allows it`); return "native"; }
    return id;
  };
  return { face: pick("face", want.face), voice: pick("voice", want.voice), fallbacks };
}

// ---------------------------------------------------------------- vendor adapters (server-side)

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }>;

function speakable(u: unknown, env: NodeJS.ProcessEnv): ApprovedUtterance {
  if (!verifyUtterance(u, presenterSecret(env))) throw new DeliveryRefused("refusing to send unsigned or altered text to a third-party presenter");
  return u;
}

export interface Speech { mime: string; audio_b64: string; provider: string; chars: number }

/** Default Gemini prebuilt voice per presenter role; override with FE_VOICE_FOUNDER / FE_VOICE_CTO / FE_VOICE_CFO. */
export const GEMINI_PERSONA_VOICES: Record<Persona, string> = { founder: "Charon", cto: "Kore", cfo: "Puck" };

/** Gemini TTS returns raw 16-bit PCM (24 kHz mono); wrap it so a browser can play it. */
export function pcmToWav(pcm: Buffer, rate = 24000, channels = 1, bits = 16): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE((rate * channels * bits) / 8, 28); h.writeUInt16LE((channels * bits) / 8, 32); h.writeUInt16LE(bits, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Turn an approved utterance into audio with the chosen voice. Only signed text is ever sent. */
export async function synthesize(voice: string, u: unknown, env: NodeJS.ProcessEnv = process.env, f: Fetch = fetch as unknown as Fetch): Promise<Speech> {
  const ok = speakable(u, env);
  const spec = provider("voice", voice);
  if (!spec || voice === "native") throw new DeliveryRefused(`voice "${voice}" is not a server voice`);
  const st = providerStatus(spec, env);
  if (!st.configured) throw new DeliveryRefused(`${spec.name} is not configured (needs ${st.missing.join(", ")})`);
  if (ok.restricted && !st.restricted_ok) throw new DeliveryRefused(`${spec.name}: restricted content is not sent to this provider`);
  const text = ok.speech;
  let r;
  if (voice === "gemini") {
    const voiceName = env[`FE_VOICE_${ok.persona.toUpperCase()}`] ?? GEMINI_PERSONA_VOICES[ok.persona];
    const model = env.FE_GEMINI_TTS_MODEL ?? "gemini-3.1-flash-tts-preview";
    r = await f(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": env.GEMINI_API_KEY!, "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text }] }], generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } } }),
    });
    if (!r.ok) throw new Error(`${spec.name} returned HTTP ${r.status}`);
    const j = (await r.json()) as { candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[] };
    const data = j.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!data) throw new Error(`${spec.name} returned no audio`);
    return { mime: "audio/wav", audio_b64: pcmToWav(Buffer.from(data, "base64")).toString("base64"), provider: voice, chars: text.length };
  } else if (voice === "elevenlabs") {
    r = await f(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(env.ELEVENLABS_VOICE_ID!)}`, {
      method: "POST",
      headers: { "xi-api-key": env.ELEVENLABS_API_KEY!, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: env.ELEVENLABS_MODEL_ID ?? "eleven_v4" }),
    });
  } else if (voice === "cartesia") {
    r = await f("https://api.cartesia.ai/tts/bytes", {
      method: "POST",
      headers: { "x-api-key": env.CARTESIA_API_KEY!, "cartesia-version": env.CARTESIA_VERSION ?? "2025-04-16", "content-type": "application/json" },
      body: JSON.stringify({ model_id: env.CARTESIA_MODEL_ID ?? "sonic-3", transcript: text, voice: { mode: "id", id: env.CARTESIA_VOICE_ID }, output_format: { container: "mp3", sample_rate: 44100, bit_rate: 128000 } }),
    });
  } else if (voice === "inworld") {
    r = await f("https://api.inworld.ai/tts/v1/voice", {
      method: "POST",
      headers: { authorization: `Basic ${env.INWORLD_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ text, voiceId: env.INWORLD_VOICE_ID, modelId: env.INWORLD_MODEL_ID ?? "inworld-tts-1-max" }),
    });
    if (!r.ok) throw new Error(`${spec.name} returned HTTP ${r.status}`);
    const j = (await r.json()) as { audioContent?: string };
    if (!j.audioContent) throw new Error(`${spec.name} returned no audio`);
    return { mime: "audio/mpeg", audio_b64: j.audioContent, provider: voice, chars: text.length };
  } else {
    throw new DeliveryRefused(`no synthesis adapter for "${voice}"`);
  }
  if (!r.ok) throw new Error(`${spec.name} returned HTTP ${r.status}`);
  return { mime: "audio/mpeg", audio_b64: Buffer.from(await r.arrayBuffer()).toString("base64"), provider: voice, chars: text.length };
}

/** Create a vendor face session. Returns only what the browser needs to join; API keys stay here. */
export async function createFaceSession(face: string, env: NodeJS.ProcessEnv = process.env, f: Fetch = fetch as unknown as Fetch): Promise<Record<string, unknown>> {
  const spec = provider("face", face);
  if (!spec || face === "native") throw new DeliveryRefused(`face "${face}" has no vendor session`);
  const st = providerStatus(spec, env);
  if (!st.configured) throw new DeliveryRefused(`${spec.name} is not configured (needs ${st.missing.join(", ")})`);
  if (face === "tavus") {
    const r = await f("https://tavusapi.com/v2/conversations", {
      method: "POST",
      headers: { "x-api-key": env.TAVUS_API_KEY!, "content-type": "application/json" },
      body: JSON.stringify({ replica_id: env.TAVUS_REPLICA_ID, persona_id: env.TAVUS_PERSONA_ID, require_auth: true }),
    });
    if (!r.ok) throw new Error(`Tavus returned HTTP ${r.status}`);
    const j = (await r.json()) as { conversation_id?: string; conversation_url?: string; meeting_token?: string };
    return { provider: "tavus", conversation_id: j.conversation_id, conversation_url: j.conversation_url, meeting_token: j.meeting_token, note: spec.live_note };
  }
  if (face === "heygen") {
    const t = await f("https://api.liveavatar.com/v1/sessions/token", {
      method: "POST",
      headers: { "x-api-key": env.LIVEAVATAR_API_KEY!, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ mode: "LITE", avatar_id: env.LIVEAVATAR_AVATAR_ID }),
    });
    if (!t.ok) throw new Error(`LiveAvatar token returned HTTP ${t.status}`);
    const tok = (await t.json()) as { session_id?: string; session_token?: string; data?: { session_id?: string; session_token?: string } };
    const token = tok.session_token ?? tok.data?.session_token;
    if (!token) throw new Error("LiveAvatar returned no session token");
    const s = await f("https://api.liveavatar.com/v1/sessions/start", { method: "POST", headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    if (!s.ok) throw new Error(`LiveAvatar start returned HTTP ${s.status}`);
    const st2 = (await s.json()) as { data?: { livekit_url?: string; livekit_client_token?: string } } & { livekit_url?: string; livekit_client_token?: string };
    return { provider: "heygen", session_id: tok.session_id ?? tok.data?.session_id, livekit_url: st2.data?.livekit_url ?? st2.livekit_url, livekit_client_token: st2.data?.livekit_client_token ?? st2.livekit_client_token, note: spec.live_note };
  }
  throw new DeliveryRefused(`${spec.name}: ${spec.live_note}`);
}
