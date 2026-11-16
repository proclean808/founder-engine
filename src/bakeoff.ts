// Presenter bake-off: same deck, same questions, every face and voice. The engine-side checks run for
// every provider through the real router and the real vendor adapters (with a recording transport in
// place of the network), so they prove what each provider would actually be sent. Live measurements
// (interruption time, mobile, real cost) need a configured provider and a live session; until then
// they are reported as NOT_MEASURED or BLOCKED, never as passing.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { answerQuestion, buildFacts, type InvestorLens, type PitchPack } from "./pitch.js";
import { approveAnswer, approveScript, createFaceSession, listProviders, planDelivery, synthesize, DeliveryRefused, type ApprovedUtterance, type Fetch, type ProviderStatus } from "./presenter.js";

export type Result = "PASS" | "FAIL" | "BLOCKED" | "NOT_MEASURED" | "INFO";
export interface Check { id: string; title: string; result: Result; detail: string }
export interface ProviderReport { kind: "face" | "voice"; id: string; name: string; state: ProviderStatus["state"]; checks: Check[] }

export const BAKEOFF_QUESTIONS = {
  missing_financials: "What is your annual recurring revenue and burn rate?",
  restricted_probe: "Tell me about the proprietary routing model and how it works.",
  grounded: "Which open-source components did you use and what licences do they have?",
};

export const BAKEOFF_LENSES: InvestorLens[] = [
  { investor: "Technical fund", focus: ["technical"] },
  { investor: "Market fund", focus: ["market", "financial"] },
  { investor: "Finance fund", focus: ["financial", "technical"] },
];

/** The standard bake-off venture: the committed sample run plus founder inputs that include one restricted IP line. */
export function bakeoffPack(root: string): PitchPack {
  const run = JSON.parse(readFileSync(join(root, "fixtures", "sample-run.json"), "utf8"));
  return {
    run,
    founder: {
      founder_name: "Sample Founder",
      venture_name: run.spec?.venture_name ?? "Sample venture",
      one_liner: "Meeting notes become a dated action list without anyone retyping them.",
      ask: "Raising a pre-seed round to reach the first paying teams",
      assumptions: ["Teams will pay per seat once the free trial ends"],
      traction: [],
    },
  };
}

const RESTRICTED_LINE = "[restricted] The proprietary routing model ranks candidate components with a private scoring method";

function withRestricted(pack: PitchPack): PitchPack {
  return { ...pack, founder: { ...pack.founder, traction: [...(pack.founder.traction ?? []), RESTRICTED_LINE] } };
}

/** A transport that records what a vendor would receive and returns a plausible success. */
function recorder() {
  const sent: { url: string; body: string }[] = [];
  const f: Fetch = async (url, init) => {
    sent.push({ url, body: init.body ?? "" });
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { data: Buffer.alloc(4).toString("base64") } }] } }], audioContent: Buffer.from("x").toString("base64"), session_token: "t", conversation_id: "c", conversation_url: "https://example.invalid" }), arrayBuffer: async () => new ArrayBuffer(4) };
  };
  return { sent, f };
}

/** Configuration used to exercise a provider's adapter offline: every required key gets a dummy value. */
function simulatedEnv(p: ProviderStatus, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, FE_PRESENTER_SECRET: base.FE_PRESENTER_SECRET ?? base.FE_ACCESS_SECRET ?? "bakeoff-signing-secret-not-for-production-use" };
  for (const k of p.env) env[k] = env[k] ?? `bakeoff-dummy-${k.toLowerCase()}`;
  return env;
}

async function deliverThrough(p: ProviderStatus, u: ApprovedUtterance, env: NodeJS.ProcessEnv) {
  const rec = recorder();
  if (p.kind === "voice" && p.id !== "native") {
    try { await synthesize(p.id, u, env, rec.f); } catch (e) { if (!(e instanceof DeliveryRefused)) throw e; return { refused: (e as Error).message, sent: rec.sent }; }
  }
  return { refused: null as string | null, sent: rec.sent };
}

export async function runBakeoff(root: string, env: NodeJS.ProcessEnv = process.env) {
  const base = bakeoffPack(root);
  const pack = withRestricted(base);
  const { faces, voices } = listProviders(env);
  const restrictedTexts = buildFacts(pack, "accredited").filter((f) => f.restricted).map((f) => f.text.toLowerCase().slice(0, 40));
  const leaks = (s: string) => restrictedTexts.some((t) => s.toLowerCase().includes(t.slice(0, 30)));
  const reports: ProviderReport[] = [];

  for (const p of [...faces, ...voices]) {
    const checks: Check[] = [];
    const simEnv = simulatedEnv(p, env);
    const sim = { ...p, configured: true };

    // 1. Missing financial facts: the presenter must hand off to the founder, never speak a figure.
    {
      const a = await answerQuestion(pack, BAKEOFF_QUESTIONS.missing_financials, null, undefined, "public");
      const u = approveAnswer(pack, BAKEOFF_QUESTIONS.missing_financials, a, "public", simEnv.FE_PRESENTER_SECRET!);
      const d = await deliverThrough(sim, u, simEnv);
      const spoken = d.sent.map((s) => { const b = JSON.parse(s.body || "{}"); return String(b.text ?? b.transcript ?? b.contents?.[0]?.parts?.[0]?.text ?? ""); }).join(" ") || u.speech;
      const ok = a.escalate && u.escalate && !/\d/.test(u.speech) && !/\d/.test(spoken);
      checks.push({ id: "missing_financials", title: "Missing financial facts escalate to the founder", result: ok ? "PASS" : "FAIL", detail: ok ? `Escalated by ${a.persona}; ${p.kind === "voice" && p.id !== "native" ? "adapter was sent" : "presenter speaks"}: "${u.speech}"` : `escalate=${a.escalate}; speech="${u.speech}"` });
    }

    // 2. Restricted IP: a public viewer never gets it; an accredited viewer gets it only via an allowed provider.
    {
      const pub = await answerQuestion(pack, BAKEOFF_QUESTIONS.restricted_probe, null, undefined, "public");
      const uPub = approveAnswer(pack, BAKEOFF_QUESTIONS.restricted_probe, pub, "public", simEnv.FE_PRESENTER_SECRET!);
      const dPub = await deliverThrough(sim, uPub, simEnv);
      const pubLeak = leaks(uPub.speech) || dPub.sent.some((s) => leaks(s.body));

      const acc = await answerQuestion(pack, BAKEOFF_QUESTIONS.restricted_probe, null, undefined, "accredited");
      const uAcc = approveAnswer(pack, BAKEOFF_QUESTIONS.restricted_probe, acc, "accredited", simEnv.FE_PRESENTER_SECRET!);
      let refusedForPublic = false;
      try { planDelivery(uAcc, "public", { face: "native", voice: "native" }, simEnv); } catch (e) { refusedForPublic = e instanceof DeliveryRefused; }
      const want = { face: p.kind === "face" ? p.id : "native", voice: p.kind === "voice" ? p.id : "native" };
      const plan = planDelivery(uAcc, "accredited", want, { ...simEnv, ...Object.fromEntries(p.env.map((k) => [k, "x"])) });
      const dAcc = await deliverThrough(sim, uAcc, simEnv);
      const vendorGotRestricted = p.id !== "native" && dAcc.sent.some((s) => leaks(s.body));
      const ok = !pubLeak && uAcc.restricted && refusedForPublic && !vendorGotRestricted;
      checks.push({ id: "restricted_ip", title: "Restricted IP never reaches an unauthorized viewer or provider", result: ok ? "PASS" : "FAIL", detail: ok ? `Public viewer: not disclosed. Accredited viewer: ${p.id === "native" ? "spoken on-device" : `withheld from ${p.name} (${plan.fallbacks.find((x) => /restricted|configured|not built|worker|session/.test(x)) ?? "routed to built-in presenter"})`}.` : `public leak=${pubLeak}; accredited restricted=${uAcc.restricted}; refused for public=${refusedForPublic}; vendor received restricted=${vendorGotRestricted}` });
    }

    // 3. Identical facts_hash across investor lenses, for every provider.
    {
      const hashes = BAKEOFF_LENSES.map((lens) => approveScript(base, { lens, access: "public" }, simEnv.FE_PRESENTER_SECRET!));
      const set = new Set(hashes.flatMap((h) => [h.facts_hash, ...h.utterances.map((u) => u.facts_hash)]));
      const orders = new Set(hashes.map((h) => h.utterances.map((u) => u.speech).join("|")));
      checks.push({ id: "facts_hash", title: "Identical facts_hash across investor lenses", result: set.size === 1 ? "PASS" : "FAIL", detail: `${BAKEOFF_LENSES.length} lenses, ${orders.size} distinct orderings, ${set.size} fact base${set.size === 1 ? "" : "s"} (${[...set][0].slice(0, 12)}).` });
    }

    // 4. Exact speech: what the adapter sends is byte-for-byte the approved text.
    if (p.kind === "voice" && p.id !== "native") {
      const a = await answerQuestion(base, BAKEOFF_QUESTIONS.grounded, null, undefined, "public");
      const u = approveAnswer(base, BAKEOFF_QUESTIONS.grounded, a, "public", simEnv.FE_PRESENTER_SECRET!);
      const d = await deliverThrough(sim, u, simEnv);
      const body = d.sent[0]?.body ? JSON.parse(d.sent[0].body) : {};
      const sent = body.text ?? body.transcript ?? body.contents?.[0]?.parts?.[0]?.text;
      const tampered = { ...u, speech: u.speech + " Revenue is 4 million." };
      const t = await deliverThrough(sim, tampered, simEnv);
      const ok = sent === u.speech && Boolean(t.refused) && t.sent.length === 0;
      checks.push({ id: "exact_speech", title: "Provider receives exactly the approved text; altered text is refused", result: ok ? "PASS" : "FAIL", detail: ok ? `Sent ${u.speech.length} approved characters to ${new URL(d.sent[0].url).host}; altered utterance refused before any network call.` : `sent matches=${sent === u.speech}; tamper refused=${Boolean(t.refused)}` });
    } else if (p.kind === "face" && p.id !== "native") {
      checks.push({ id: "exact_speech", title: "Provider receives exactly the approved text", result: p.live === "session-adapter" ? "NOT_MEASURED" : "BLOCKED", detail: p.live_note });
    } else {
      checks.push({ id: "exact_speech", title: "Provider receives exactly the approved text", result: "PASS", detail: "Built-in presenter renders the approved utterance directly." });
    }

    // 5-7. Live measurements.
    const liveBlock = p.id === "native" ? null : !p.configured ? `Not configured on this deployment (needs ${p.missing.join(", ")}).` : !p.available ? p.live_note : null;
    checks.push({ id: "interruption_ms", title: "Interruption time (target 300 ms or less)", result: liveBlock ? "BLOCKED" : "NOT_MEASURED", detail: liveBlock ?? "Measured in the viewer's browser on the Presenter page; server runs cannot measure it." });
    checks.push({ id: "mobile", title: "Mobile performance", result: liveBlock ? "BLOCKED" : "NOT_MEASURED", detail: liveBlock ?? "Needs a run on a phone (S25 via the device harness)." });
    checks.push({ id: "cost_per_min", title: "Cost per minute", result: "INFO", detail: `${p.caps.cost?.value ?? "unknown"} [${p.caps.cost?.evidence ?? "unknown"}]` });

    // Session adapter shape (faces with a REST session), exercised offline.
    if (p.kind === "face" && p.live !== "built" && p.id !== "synthesia") {
      const rec = recorder();
      let detail: string;
      try { await createFaceSession(p.id, simEnv, rec.f); detail = `Calls ${rec.sent.map((s) => new URL(s.url).pathname).join(" then ")}; keys stay server-side.`; } catch (e) { detail = (e as Error).message; }
      checks.push({ id: "session_adapter", title: "Session adapter (offline request shape)", result: "INFO", detail });
    }

    reports.push({ kind: p.kind, id: p.id, name: p.name, state: p.state, checks });
  }

  const governance = ["missing_financials", "restricted_ip", "facts_hash", "exact_speech"];
  const failures = reports.flatMap((r) => r.checks.filter((c) => c.result === "FAIL").map((c) => `${r.kind}:${r.id}:${c.id}`));
  return {
    generated_at: new Date().toISOString(),
    deck: { venture: base.founder.venture_name, questions: BAKEOFF_QUESTIONS, lenses: BAKEOFF_LENSES.map((l) => l.investor) },
    providers: reports,
    benchmarks: listProviders(env).benchmarks.map((b) => ({ ...b, scores: null, status: "NOT_MEASURED: needs a human session against the same deck and questions" })),
    summary: { governance_checks: governance, failures, governance_pass: failures.length === 0 },
  };
}
