// Pitch studio engine (Milestone 2).
// An interactive pitch is generated ONLY from an evidence pack: a founder-engine curate run plus
// founder-stated inputs. Three presenters share one fact base with distinct responsibilities:
//   founder - the founder's digital twin: problem, user, vision, constraints, the ask
//   cto     - co-CTO: architecture, components, licences, provenance, tests, what is not built
//   cfo     - co-CFO: business model and financial assumptions EXACTLY as the founder stated them
// Rules: every scripted line cites a fact; answers cite facts; no number may appear in an answer
// unless it appears in the cited facts; when the evidence is silent the presenter escalates to the
// human founder instead of guessing. Presenters are synthetic and labelled as such.
import { createHash } from "node:crypto";
import type { ChatProvider } from "./provider.js";
import type { RegistryEntry, VentureSpec } from "./types.js";

export type Persona = "founder" | "cto" | "cfo";

export const PERSONAS: Record<Persona, { title: string; role: string; covers: string[] }> = {
  founder: {
    title: "Founder (digital twin)",
    role: "Speaks for the founder's vision, problem, customer and ask, from the founder's own statements.",
    covers: ["problem", "customer", "vision", "constraints", "ask", "roadmap"],
  },
  cto: {
    title: "Co-CTO",
    role: "Explains the architecture, the curated open-source components, their licences and provenance, and test evidence.",
    covers: ["architecture", "components", "licences", "provenance", "tests", "gaps"],
  },
  cfo: {
    title: "Co-CFO",
    role: "Explains the business model and financial assumptions exactly as the founder stated them. Never invents numbers.",
    covers: ["business model", "pricing", "costs", "funding ask", "assumptions"],
  },
};

export interface Fact {
  id: string; // F1, F2, ...
  persona: Persona;
  kind: string;
  text: string;
  source: string; // where the fact came from (spec, registry, receipt hash, founder input)
  restricted?: boolean; // founder-marked IP: served only to viewers with verified accredited access
}

export type AccessLevel = "public" | "identified" | "accredited";

export interface FounderInputs {
  founder_name?: string;
  venture_name?: string;
  one_liner?: string;
  ask?: string; // e.g. "Raising $250k pre-seed for 12 months"
  assumptions?: string[]; // founder-stated business/financial assumptions, one per line
  traction?: string[]; // founder-stated traction, one per line
}

export interface RunPack {
  run_id?: string;
  engine_commit?: string | null;
  runner?: string;
  status: string;
  status_reason: string;
  selected?: string | null;
  spec: VentureSpec;
  registry: RegistryEntry[];
  receipts: { kind: string; subject: string; result: string; receipt_hash: string; outputs?: unknown }[];
  artifact?: { text: string; owner: string | null; due: string | null }[] | null;
  chain_intact?: boolean;
}

export interface PitchPack {
  run: RunPack;
  founder: FounderInputs;
}

const clean = (s: unknown, max = 400) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Validate and normalise an untrusted pitch pack (it arrives from the browser). */
export function normalizePack(raw: unknown): PitchPack {
  const p = (raw ?? {}) as { run?: RunPack; founder?: FounderInputs };
  const run = p.run;
  if (!run || typeof run !== "object" || !run.spec || !Array.isArray(run.registry) || !Array.isArray(run.receipts)) {
    throw new Error("pack.run must be a founder-engine curate result (spec, registry, receipts)");
  }
  const f = p.founder ?? {};
  const lines = (v: unknown) => (Array.isArray(v) ? v : typeof v === "string" ? v.split("\n") : []).map((x) => clean(x, 300)).filter(Boolean).slice(0, 20);
  return {
    run,
    founder: {
      founder_name: clean(f.founder_name, 80) || undefined,
      venture_name: clean(f.venture_name, 80) || undefined,
      one_liner: clean(f.one_liner, 300) || undefined,
      ask: clean(f.ask, 300) || undefined,
      assumptions: lines(f.assumptions),
      traction: lines(f.traction),
    },
  };
}

const RESTRICTED = /^\s*(\[restricted\]|!)\s*/i;

/**
 * Build the fact base. Founder lines prefixed with "[restricted]" (or "!") are IP: they only reach
 * viewers whose access level is "accredited". Ids are assigned over the FULL fact set so they are
 * stable across access levels; restricted facts are then removed, never paraphrased.
 */
export function buildFacts(pack: PitchPack, access: AccessLevel = "public"): Fact[] {
  const all = buildAllFacts(pack);
  return access === "accredited" ? all : all.filter((f) => !f.restricted);
}

function buildAllFacts(pack: PitchPack): Fact[] {
  const { run, founder } = pack;
  const facts: Fact[] = [];
  const add = (persona: Persona, kind: string, text: string, source: string) => {
    const restricted = RESTRICTED.test(text) || /: \s*(\[restricted\]|!)/i.test(text);
    facts.push({ id: `F${facts.length + 1}`, persona, kind, text: text.replace(/(\[restricted\]|^!|: !)\s*/gi, (m) => (m.startsWith(":") ? ": " : "")), source, ...(restricted ? { restricted: true } : {}) });
  };
  const s = run.spec;

  // Founder twin: the founder's own words and the structured spec derived from them
  if (founder.one_liner) add("founder", "one_liner", founder.one_liner, "founder input");
  add("founder", "problem", `The problem as the founder described it: ${clean(s.problem)}`, "venture spec");
  if (s.target_user) add("founder", "customer", `The target user is ${clean(s.target_user)}.`, "venture spec");
  add("founder", "stage", `The venture is at the ${s.stage} stage.`, "venture spec");
  if (s.constraints.length) add("founder", "constraints", `Founder constraints: ${s.constraints.join(", ")}.`, "venture spec");
  for (const t of founder.traction ?? []) add("founder", "traction", `Founder-stated traction: ${t}`, "founder input (not independently verified)");
  if (founder.ask) add("founder", "ask", `The ask: ${founder.ask}`, "founder input");
  if (s.open_questions.length) add("founder", "open_questions", `Questions the founder still has to answer: ${s.open_questions.join(" ")}`, "venture spec");

  // Co-CTO: what was actually curated, verified and tested
  add("cto", "capabilities", `The product needs these building blocks: ${s.capabilities.map((c) => c.description).join("; ") || "none identified yet"}.`, "venture spec");
  for (const c of run.registry) {
    const pin = c.pinnedCommit ? ` pinned at commit ${c.pinnedCommit.slice(0, 12)}` : "";
    add("cto", "component", `Open-source component ${c.name} ${c.version}, ${c.license ? `${c.license} licence` : "licence unverified"}${pin}, for ${c.capability}: status ${c.status}. ${clean(c.statusReason, 200)}`, `registry; receipts ${c.evidence.slice(0, 2).map((h) => h.slice(0, 12)).join(", ") || "none"}`);
  }
  const acc = [...run.receipts].reverse().find((r) => r.kind === "acceptance");
  if (acc && Array.isArray(acc.outputs)) {
    const cases = acc.outputs as { caseId: string; input: string; expected: string | null; actual: string | null; pass: boolean }[];
    const passed = cases.filter((c) => c.pass).length;
    add("cto", "tests", `The acceptance test ${acc.result === "PASS" ? "passed" : "failed"}: ${passed} of ${cases.length} cases, for example "${clean(cases[0]?.input, 80)}" resolved to ${cases[0]?.actual ?? "nothing"}.`, `receipt ${acc.receipt_hash.slice(0, 12)}`);
  }
  if (run.artifact?.length) add("cto", "artifact", `A working tool was produced: it extracted ${run.artifact.length} action items from sample notes, for example "${clean(run.artifact[0].text, 80)}" due ${run.artifact[0].due ?? "unscheduled"}.`, "generated artifact");
  add("cto", "status", `Overall engineering status is ${run.status}: ${clean(run.status_reason, 250)}`, `run ${run.run_id ?? "?"}`);
  add("cto", "evidence", `Every step was recorded in ${run.receipts.length} hash-chained receipts; the chain is ${run.chain_intact ? "intact" : "not verified"}. Runner: ${run.runner ?? "unknown"}${run.engine_commit ? `, engine commit ${run.engine_commit.slice(0, 7)}` : ""}.`, "evidence ledger");
  if (run.runner !== "ci") add("cto", "verification_limit", `These results come from the hosted ${run.runner ?? "service"} runner, so they count as Tested, not independently Verified.`, "verification policy");

  // Co-CFO: only what the founder stated
  for (const a of founder.assumptions ?? []) add("cfo", "assumption", `Founder-stated assumption: ${a}`, "founder input (assumption, not a result)");
  if (founder.ask) add("cfo", "ask", `Funding ask as stated by the founder: ${founder.ask}`, "founder input");
  const licences = [...new Set(run.registry.filter((c) => c.status !== "Blocked").map((c) => c.license).filter(Boolean))];
  if (licences.length) add("cfo", "licence_cost", `The curated components carry ${licences.join(", ")} licences, which have no licence fees.`, "registry");
  if (!founder.assumptions?.length) add("cfo", "no_assumptions", "No financial assumptions have been provided by the founder yet, so there are no revenue, pricing or cost figures to present.", "founder input (absent)");
  return facts;
}

// ---------- scripted presentation ----------

export interface ScriptLine {
  persona: Persona;
  section: string;
  text: string;
  cites: string[];
}

export type Focus = "technical" | "market" | "financial";

/** Investor lens: changes EMPHASIS and ORDER only. The fact base is identical for every lens. */
export interface InvestorLens {
  investor?: string; // display name, e.g. "Jane Doe, Acme Ventures"
  focus: Focus[]; // most important first, e.g. ["technical", "market"]
  basis?: string; // where the focus came from, e.g. "public portfolio: 6 of 9 deals are dev tools"
}

export function factsHash(facts: Fact[]): string {
  const canon = JSON.stringify(facts.map((f) => [f.id, f.persona, f.kind, f.text, f.source]));
  return createHash("sha256").update(canon).digest("hex");
}

export function buildScript(pack: PitchPack, opts: { lens?: InvestorLens; access?: AccessLevel } = {}): { facts: Fact[]; facts_hash: string; script: ScriptLine[]; title: string; lens: InvestorLens | null; access: AccessLevel } {
  const access = opts.access ?? "public";
  const facts = buildFacts(pack, access);
  const by = (kind: string) => facts.filter((f) => f.kind === kind);
  const one = (kind: string) => by(kind)[0];
  const venture = pack.founder.venture_name ?? pack.run.spec.venture_name;
  const who = pack.founder.founder_name ? `${pack.founder.founder_name}'s digital twin` : "the founder's digital twin";
  const strip = (f?: Fact) => f?.text ?? "";
  const line = (persona: Persona, section: string, text: string, fs: (Fact | undefined)[]): ScriptLine[] => {
    const cites = fs.filter(Boolean).map((f) => f!.id);
    return cites.length && text.trim() ? [{ persona, section, text: text.trim(), cites }] : [];
  };

  const opening = [
    ...line("founder", "Opening", `I'm ${who}, a synthetic presenter for ${venture}. ${strip(one("one_liner"))}`, [one("one_liner") ?? one("problem")]),
    ...line("founder", "Problem", strip(one("problem")), [one("problem")]),
  ];
  const market = [
    ...line("founder", "Customer", `${strip(one("customer"))} ${strip(one("stage"))} ${strip(one("constraints"))}`, [one("customer"), one("stage"), one("constraints")]),
    ...by("traction").flatMap((t) => line("founder", "Traction", t.text, [t])),
  ];
  const rank = (f: Fact) => (/status (Verified|Tested)/.test(f.text) ? 0 : /status (Integrated|Proposed)/.test(f.text) ? 1 : 2);
  const comps = [...by("component")].sort((a, b) => rank(a) - rank(b));
  const blocked = comps.filter((c) => rank(c) === 2);
  const technical = [
    ...line("cto", "Building blocks", `I'm the co-CTO. ${strip(one("capabilities"))}`, [one("capabilities")]),
    ...comps.slice(0, 3).flatMap((c) => line("cto", "Curated components", c.text, [c])),
    ...(blocked.length ? line("cto", "Curated components", `${blocked.length} other candidate${blocked.length > 1 ? "s were" : " was"} rejected by provenance or licence checks.`, blocked) : []),
    ...line("cto", "Proof", `${strip(one("tests"))} ${strip(one("artifact"))}`, [one("tests"), one("artifact")]),
    ...line("cto", "Evidence and limits", `${strip(one("status"))} ${strip(one("evidence"))} ${strip(one("verification_limit"))}`, [one("status"), one("evidence"), one("verification_limit")]),
  ];
  const financial = by("assumption").length
    ? [
        ...line("cfo", "Business model", "I'm the co-CFO. Everything I present is the founder's stated assumption, not a measured result.", [by("assumption")[0]]),
        ...by("assumption").flatMap((a) => line("cfo", "Assumptions", a.text, [a])),
        ...line("cfo", "Costs", strip(one("licence_cost")), [one("licence_cost")]),
      ]
    : [...line("cfo", "Business model", `I'm the co-CFO. ${strip(one("no_assumptions"))}`, [one("no_assumptions")]), ...line("cfo", "Costs", strip(one("licence_cost")), [one("licence_cost")])];
  const closing = [
    ...line("founder", "The ask", strip(one("ask")), [one("ask")]),
    ...line("founder", "Open questions", strip(one("open_questions")), [one("open_questions")]),
    ...line("founder", "Close", "Ask any of us a question. If the evidence doesn't cover it, we'll route it to the founder instead of guessing.", [one("problem")]),
  ];

  const blocks: Record<Focus, ScriptLine[]> = { market, technical, financial };
  const lens = opts.lens && opts.lens.focus?.length ? opts.lens : null;
  const order: Focus[] = lens ? [...new Set([...lens.focus.filter((f) => f in blocks), "market", "technical", "financial"] as Focus[])] : ["market", "technical", "financial"];
  const lensIntro = lens
    ? line("founder", "Opening", `${lens.investor ? `${lens.investor}, ` : ""}we've ordered this around what you focus on: ${order.slice(0, lens.focus.length).join(" and ")} first. The underlying facts are identical for every investor at your access level.`, [one("problem")])
    : [];
  const script = [...opening.slice(0, 1), ...lensIntro, ...opening.slice(1), ...order.flatMap((k) => blocks[k]), ...closing];
  return { facts, facts_hash: factsHash(facts), script, title: venture, lens, access };
}

// ---------- Q&A ----------

const ROUTES: [Persona, RegExp][] = [
  ["cfo", /\b(revenue|price|pricing|cost|costs|margin|raise|raising|valuation|burn|runway|cac|ltv|arr|mrr|profit|money|budget|financ\w*|invest\w*|funding|unit economics|market size|tam|sam|som|\$)/i],
  ["cto", /\b(architect\w*|stack|licen[cs]e\w*|security|secure|scal\w*|test\w*|code|open[- ]source|dependenc\w*|api|latency|data|component\w*|provenance|commit|build|tech\w*|infra\w*|offline|integrat\w*)/i],
];

export function routeQuestion(q: string): Persona {
  for (const [p, re] of ROUTES) if (re.test(q)) return p;
  return "founder";
}

const STOP = new Set("the a an and or of to in for on with is are was were be it this that what how why who does do did can could would should will your you we our they their there about from at by as".split(" "));
/** Tiny stemmer: price/pricing, licence/license/licenses, test/tests/tested all collapse. */
export function stem(t: string): string {
  let w = t.toLowerCase().replace(/licenc/g, "licens");
  if (w.length > 4) w = w.replace(/(ing|ed|es|s)$/, "");
  if (w.length > 4) w = w.replace(/e$/, "");
  return w;
}
const toks = (s: string) => (s.toLowerCase().match(/[a-z0-9][a-z0-9.\-]*/g) ?? []).filter((t) => !STOP.has(t) && t.length > 1).map(stem);

export function retrieve(facts: Fact[], q: string, persona: Persona, k = 3): { fact: Fact; score: number }[] {
  const qt = new Set(toks(q));
  return facts
    .map((fact) => {
      const ft = toks(fact.text + " " + fact.kind);
      let score = 0;
      for (const t of qt) if (ft.includes(t)) score += 1;
      if (score > 0) {
        score += fact.persona === persona ? 1 : -0.5; // the routed presenter answers from their own facts first
        if (/status (Tested|Verified)/.test(fact.text)) score += 0.75; // lead with what actually works
        if (/status Blocked/.test(fact.text)) score -= 0.75;
      }
      return { fact, score };
    })
    .filter((r) => r.score >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

const NUM = /\d[\d,]*(?:\.\d+)?%?/g;
const normNum = (n: string) => n.replace(/,/g, "").replace(/%$/, "");

/** Every number in the answer must appear in the cited facts. Returns the offending numbers. */
export function ungroundedNumbers(answer: string, facts: Fact[]): string[] {
  const body = answer.replace(/\[F\d+\]/g, "");
  const allowed = new Set((facts.map((f) => f.text).join(" ").match(NUM) ?? []).map(normNum));
  return [...new Set((body.match(NUM) ?? []).map(normNum))].filter((n) => !allowed.has(n));
}

export interface Answer {
  persona: Persona;
  answer: string;
  cites: string[];
  escalate: boolean;
  mode: "evidence-retrieval" | "llm-grounded" | "llm-rejected-fallback";
  note?: string;
}

function escalation(persona: Persona, q: string): Answer {
  const why =
    persona === "cfo"
      ? "The founder hasn't given me figures for that, and I won't invent numbers."
      : persona === "cto"
        ? "There is no engineering evidence for that in this run."
        : "That isn't covered by what the founder has told me.";
  return { persona, answer: `${why} I've added it to the founder's follow-up list: "${clean(q, 160)}"`, cites: [], escalate: true, mode: "evidence-retrieval" };
}

export async function answerQuestion(pack: PitchPack, question: string, provider: ChatProvider | null, persona?: Persona, access: AccessLevel = "public"): Promise<Answer> {
  const facts = buildFacts(pack, access);
  const who = persona ?? routeQuestion(question);
  const hits = retrieve(facts, question, who);
  if (!hits.length) return escalation(who, question);
  const deterministic: Answer = {
    persona: who,
    answer: hits.map((h) => `${h.fact.text} [${h.fact.id}]`).join(" "),
    cites: hits.map((h) => h.fact.id),
    escalate: false,
    mode: "evidence-retrieval",
  };
  if (!provider) return deterministic;

  const context = hits.map((h) => `[${h.fact.id}] (${h.fact.source}) ${h.fact.text}`).join("\n");
  let text: string;
  try {
    text = await provider.chat([
      {
        role: "system",
        content:
          `You are the ${PERSONAS[who].title} in a live investor Q&A. ${PERSONAS[who].role} You are a synthetic presenter. ` +
          `Answer in 1-3 spoken sentences using ONLY the facts below, and cite them like [F3]. ` +
          `Never state a number that is not in the facts. Never claim results that are not in the facts. ` +
          `If the facts do not answer the question, reply exactly: ESCALATE.\n\nFacts:\n${context}`,
      },
      { role: "user", content: question },
    ]);
  } catch (e) {
    return { ...deterministic, mode: "llm-rejected-fallback", note: `provider error: ${(e as Error).message}` };
  }
  if (/^\s*ESCALATE\s*$/i.test(text)) return { ...escalation(who, question), mode: "llm-grounded" };
  const cited = [...new Set((text.match(/\[F\d+\]/g) ?? []).map((c) => c.slice(1, -1)))];
  const valid = cited.filter((c) => hits.some((h) => h.fact.id === c));
  const citedFacts = facts.filter((f) => valid.includes(f.id));
  const bad = ungroundedNumbers(text, citedFacts.length ? citedFacts : hits.map((h) => h.fact));
  if (!valid.length || valid.length !== cited.length || bad.length) {
    return { ...deterministic, mode: "llm-rejected-fallback", note: !valid.length ? "llm answer had no valid citation" : bad.length ? `llm answer contained ungrounded numbers: ${bad.join(", ")}` : "llm cited facts outside the retrieved set" };
  }
  return { persona: who, answer: text.trim(), cites: valid, escalate: false, mode: "llm-grounded" };
}
