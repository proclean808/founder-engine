// Native live room: credentials, briefs, tools and guard inputs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { liveStatus, mintSession, presenterBrief, runTool, seats, allowedNumbers, LiveError } from "../src/live.js";
import { bakeoffPack } from "../src/bakeoff.js";
import { buildFacts, type PitchPack } from "../src/pitch.js";
import { PROJECT_ROOT } from "../src/web.js";

const base = bakeoffPack(PROJECT_ROOT);
const withIp: PitchPack = { ...base, founder: { ...base.founder, traction: ["[restricted] The proprietary routing model ranks candidate components with a private scoring method"] } };

function rec(reply: unknown) {
  const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
  const f = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => { sent.push({ url, headers: init.headers, body: init.body ?? "" }); return { ok: true, status: 200, json: async () => reply, text: async () => "" }; };
  return { sent, f };
}

test("default seating puts one native flagship model in each chair; overridable", () => {
  assert.deepEqual(seats({}), { founder: "grok", cto: "gemini", cfo: "openai" });
  assert.deepEqual(seats({ FE_LIVE_SEATS: "founder:openai,cto:openai" }), { founder: "openai", cto: "openai", cfo: "openai" });
  const st = liveStatus({ GEMINI_API_KEY: "x" });
  assert.equal(st.ready, false);
  assert.deepEqual(st.seats.filter((s) => s.ready).map((s) => s.persona), ["cto"]);
});

test("briefs: rules, own talking points, facts only; restricted facts withheld unless accredited AND allowed", () => {
  const pub = presenterBrief(withIp, "cto", "public");
  assert.match(pub.instructions, /Never say a number unless it appears in those facts/);
  assert.match(pub.instructions, /call hand_off to cfo/);
  assert.doesNotMatch(pub.instructions, /private scoring/);
  assert.ok(pub.restricted_terms.includes("proprietary"));
  const accNoOptIn = presenterBrief(withIp, "founder", "accredited");
  assert.doesNotMatch(accNoOptIn.instructions, /private scoring/, "accredited viewer but provider not allowed: still withheld from the vendor");
  const acc = presenterBrief(withIp, "founder", "accredited", { includeRestricted: true });
  assert.match(acc.instructions, /private scoring/);
  assert.deepEqual(acc.restricted_terms, []);
  assert.deepEqual(pub.allowed_numbers, allowedNumbers(buildFacts(withIp, "identified")));
  assert.equal(presenterBrief(base, "cfo", "public").facts_hash, presenterBrief(base, "cto", "public").facts_hash);
});

test("session credentials: keys stay on the server; each vendor gets its documented call", async () => {
  const brief = presenterBrief(base, "founder", "public");
  const o = rec({ value: "ek_test" });
  const s1 = await mintSession("openai", brief, undefined, { OPENAI_API_KEY: "sk-secret" }, o.f);
  assert.equal(o.sent[0].url, "https://api.openai.com/v1/realtime/client_secrets");
  assert.equal(JSON.parse(o.sent[0].body).session.type, "realtime");
  assert.equal(s1.secret, "ek_test");
  assert.doesNotMatch(JSON.stringify(s1), /sk-secret/);

  const g = rec({ value: "xai_ephemeral" });
  const s2 = await mintSession("grok", brief, "ara", { XAI_API_KEY: "xai-secret" }, g.f);
  assert.equal(g.sent[0].url, "https://api.x.ai/v1/realtime/client_secrets");
  assert.equal(s2.voice, "ara");
  assert.doesNotMatch(JSON.stringify(s2), /xai-secret/);

  const m = rec({ name: "auth_tokens/abc" });
  const s3 = await mintSession("gemini", brief, undefined, { GEMINI_API_KEY: "g-secret" }, m.f);
  assert.equal(m.sent[0].url, "https://generativelanguage.googleapis.com/v1alpha/auth_tokens");
  assert.match(String(s3.connect), /BidiGenerateContentConstrained\?access_token=auth_tokens%2Fabc$/);
  assert.deepEqual((s3 as { setup: { generationConfig: { responseModalities: string[] } } }).setup.generationConfig.responseModalities, ["AUDIO"]);
  assert.doesNotMatch(JSON.stringify(s3), /g-secret/);

  await assert.rejects(mintSession("openai", brief, undefined, {}), LiveError);
});

test("tools: evidence is access-filtered, uncovered money questions escalate, hand-offs validated", async () => {
  const arr = await runTool(base, "public", "get_evidence", { question: "What is your annual recurring revenue?" });
  assert.equal(arr.covered, false);
  const lic = await runTool(base, "public", "get_evidence", { question: "Which open-source components and licences did you use?" });
  assert.equal(lic.covered, true);
  assert.ok((lic.facts as unknown[]).length > 0);
  const leak = await runTool(withIp, "public", "get_evidence", { question: "Tell me about the proprietary routing model" });
  assert.doesNotMatch(JSON.stringify(leak), /private scoring/);
  assert.equal((await runTool(base, "public", "hand_off", { to: "cfo", question: "pricing?" })).to, "cfo");
  assert.equal((await runTool(base, "public", "hand_off", { to: "ceo" })).ok, false);
});
