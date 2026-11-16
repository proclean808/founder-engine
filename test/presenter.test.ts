// Presenter system: the engine approves, the router decides, vendors only ever receive signed text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { answerQuestion, type PitchPack } from "../src/pitch.js";
import { approveAnswer, approveScript, planDelivery, synthesize, verifyUtterance, listProviders, createFaceSession, DeliveryRefused, type Fetch } from "../src/presenter.js";
import { bakeoffPack, runBakeoff } from "../src/bakeoff.js";
import { PROJECT_ROOT } from "../src/web.js";

const SECRET = "test-presenter-secret-0123456789abcdef";
const base = bakeoffPack(PROJECT_ROOT);
const withIp: PitchPack = { ...base, founder: { ...base.founder, traction: ["[restricted] The proprietary routing model ranks candidate components with a private scoring method"] } };
const ENV = { FE_PRESENTER_SECRET: SECRET, ELEVENLABS_API_KEY: "k", ELEVENLABS_VOICE_ID: "v" } as NodeJS.ProcessEnv;

function rec() {
  const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
  const f: Fetch = async (url, init) => { sent.push({ url, headers: init.headers, body: init.body ?? "" }); return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(2) }; };
  return { sent, f };
}

test("every scripted line is approved, signed and cites facts", () => {
  const d = approveScript(base, {}, SECRET);
  assert.ok(d.utterances.length > 5);
  for (const u of d.utterances) {
    assert.ok(verifyUtterance(u, SECRET), u.id);
    assert.ok(u.cites.length > 0, u.id);
    assert.equal(u.facts_hash, d.facts_hash);
    assert.doesNotMatch(u.speech, /\[F\d+\]/);
  }
});

test("an altered utterance is refused before any network call", async () => {
  const a = await answerQuestion(base, "Which open-source components did you use?", null);
  const u = approveAnswer(base, "q", a, "public", SECRET);
  const r = rec();
  await synthesize("elevenlabs", u, ENV, r.f);
  assert.equal(r.sent.length, 1);
  assert.equal(JSON.parse(r.sent[0].body).text, u.speech);
  assert.equal(r.sent[0].headers["xi-api-key"], "k");
  const r2 = rec();
  await assert.rejects(synthesize("elevenlabs", { ...u, speech: u.speech + " We have 9 customers." }, ENV, r2.f), DeliveryRefused);
  assert.equal(r2.sent.length, 0);
  await assert.rejects(synthesize("elevenlabs", { ...u, sig: null }, ENV, r2.f), DeliveryRefused);
});

test("escalations never repeat the investor's numbers", async () => {
  const q = "Is your ARR above 5 million with 40% margins?";
  const a = await answerQuestion(base, q, null);
  assert.equal(a.escalate, true);
  const u = approveAnswer(base, q, a, "public", SECRET);
  assert.doesNotMatch(u.speech, /\d/);
  assert.deepEqual(u.cites, []);
});

test("restricted content: refused for public viewers, kept off third-party voices unless the founder allows it", async () => {
  const q = "Tell me about the proprietary routing model";
  const pub = approveAnswer(withIp, q, await answerQuestion(withIp, q, null, undefined, "public"), "public", SECRET);
  assert.equal(pub.restricted, false);
  assert.doesNotMatch(pub.speech, /private scoring/);

  const u = approveAnswer(withIp, q, await answerQuestion(withIp, q, null, undefined, "accredited"), "accredited", SECRET);
  assert.equal(u.restricted, true);
  assert.throws(() => planDelivery(u, "public", { face: "native", voice: "native" }, ENV), DeliveryRefused);
  assert.throws(() => planDelivery(u, "identified", { face: "native", voice: "native" }, ENV), DeliveryRefused);

  const plan = planDelivery(u, "accredited", { face: "native", voice: "elevenlabs" }, ENV);
  assert.equal(plan.voice, "native");
  assert.match(plan.fallbacks.join(" "), /restricted content is not sent/);
  const r = rec();
  await assert.rejects(synthesize("elevenlabs", u, ENV, r.f), DeliveryRefused);
  assert.equal(r.sent.length, 0);

  const allowed = { ...ENV, FE_PRESENTER_ELEVENLABS_RESTRICTED_OK: "1" };
  assert.equal(planDelivery(u, "accredited", { face: "native", voice: "elevenlabs" }, allowed).voice, "elevenlabs");
});

test("unconfigured or unbuilt providers are never presented as working", () => {
  const { faces, voices } = listProviders({});
  assert.deepEqual(faces.map((f) => f.id), ["native", "synthesia", "tavus", "heygen"]);
  assert.deepEqual(voices.map((v) => v.id), ["native", "gemini", "elevenlabs", "cartesia", "inworld"]);
  for (const p of [...faces, ...voices]) assert.equal(p.available, p.id === "native", p.id);
  const allKeys = Object.fromEntries([...faces, ...voices].flatMap((p) => p.env.map((k) => [k, "x"])));
  const configured = listProviders(allKeys);
  for (const f of configured.faces.filter((x) => x.id !== "native")) assert.equal(f.available, false, `${f.id}: live path not built, must not be available`);
  for (const v of configured.voices) assert.equal(v.available, true, v.id);

  const u = approveScript(base, {}, SECRET).utterances[0];
  const plan = planDelivery(u, "public", { face: "synthesia", voice: "cartesia" }, { FE_PRESENTER_SECRET: SECRET });
  assert.deepEqual([plan.face, plan.voice], ["native", "native"]);
  assert.match(plan.fallbacks.join(" "), /Synthesia: not configured/);
  assert.match(plan.fallbacks.join(" "), /Cartesia: not configured/);
  const unsigned = planDelivery({ ...u, sig: null }, "public", { face: "native", voice: "cartesia" }, { ...allKeys, FE_PRESENTER_SECRET: SECRET });
  assert.equal(unsigned.voice, "native");
});

test("face session adapters keep API keys server-side", async () => {
  const r = rec();
  const env = { TAVUS_API_KEY: "secret-key", TAVUS_REPLICA_ID: "r1", TAVUS_PERSONA_ID: "p1" } as NodeJS.ProcessEnv;
  const out = await createFaceSession("tavus", env, r.f);
  assert.equal(r.sent[0].url, "https://tavusapi.com/v2/conversations");
  assert.equal(r.sent[0].headers["x-api-key"], "secret-key");
  assert.doesNotMatch(JSON.stringify(out), /secret-key/);
  await assert.rejects(createFaceSession("synthesia", { SYNTHESIA_API_KEY: "x", SYNTHESIA_AVATAR_ID: "a", LIVEKIT_URL: "u", LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: "s" }, r.f), DeliveryRefused);
});

test("bake-off: governance checks pass for every provider; live checks are never reported as passing", async () => {
  const r = await runBakeoff(PROJECT_ROOT, {});
  assert.equal(r.summary.governance_pass, true, r.summary.failures.join(", "));
  assert.equal(r.providers.length, 9);
  for (const p of r.providers.filter((x) => x.id !== "native")) {
    for (const id of ["interruption_ms", "mobile"]) assert.notEqual(p.checks.find((c) => c.id === id)?.result, "PASS", `${p.id}:${id}`);
  }
  assert.ok(r.benchmarks.every((b) => b.scores === null));
});

test("Gemini voices: one voice per presenter, approved text only, playable WAV back", async () => {
  const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
  const f: Fetch = async (url, init) => { sent.push({ url, headers: init.headers, body: init.body ?? "" }); return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { data: Buffer.alloc(480).toString("base64") } }] } }] }), arrayBuffer: async () => new ArrayBuffer(0) }; };
  const env = { FE_PRESENTER_SECRET: SECRET, GEMINI_API_KEY: "g-key" } as NodeJS.ProcessEnv;
  const deck = approveScript(base, {}, SECRET).utterances;
  const byPersona = new Map<string, string>();
  for (const p of ["founder", "cto", "cfo"]) {
    const u = deck.find((x) => x.persona === p)!;
    const out = await synthesize("gemini", u, env, f);
    const body = JSON.parse(sent.at(-1)!.body);
    assert.equal(body.contents[0].parts[0].text, u.speech);
    byPersona.set(p, body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName);
    assert.equal(out.mime, "audio/wav");
    assert.equal(Buffer.from(out.audio_b64, "base64").subarray(0, 4).toString(), "RIFF");
  }
  assert.equal(new Set(byPersona.values()).size, 3, "each presenter has its own voice");
  assert.equal(sent[0].headers["x-goog-api-key"], "g-key");
  assert.match(sent[0].url, /gemini-3\.1-flash-tts-preview:generateContent$/);
});

test("model selector: only explicitly configured models are offered; no silent vendor fallback", async () => {
  const { listModels, providerFor } = await import("../src/provider.js");
  const none = listModels({});
  assert.ok(none.every((m) => !m.configured));
  assert.equal(providerFor("gemini", { GEMINI_API_KEY: "k" }), null, "a key without an explicit model id is not configured");
  const p = providerFor("gemini", { GEMINI_API_KEY: "k", FE_MODEL_GEMINI: "some-model" });
  assert.match(p!.id, /some-model@generativelanguage\.googleapis\.com/);
  assert.equal(providerFor("claude", { GEMINI_API_KEY: "k", FE_MODEL_GEMINI: "m" }), null);
});

test("three presenters: the deck hands off founder -> co-CTO -> co-CFO -> founder, one speaker per line", () => {
  const order = approveScript(base, {}, SECRET).utterances.map((u) => u.persona).filter((p, i, a) => i === 0 || a[i - 1] !== p);
  assert.deepEqual(order, ["founder", "cto", "cfo", "founder"]);
});
