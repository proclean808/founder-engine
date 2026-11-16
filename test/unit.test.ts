// Offline unit tests. Network-dependent verification is exercised by `npm run pipeline`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { intakeDeterministic, intakeWithProvider } from "../src/intake.js";
import { rankCandidates, normalizeRepoUrl } from "../src/discovery.js";
import { satisfies } from "../src/compat.js";
import { hasMitClauses, verifyLicense, normalizeLicense } from "../src/license.js";
import { readTgz } from "../src/tar.js";
import { EvidenceLog } from "../src/evidence.js";
import { runChronoAcceptance } from "../src/acceptance.js";
import { extractActionItems } from "../src/product/actionItems.js";
import { OpenAICompatibleProvider, providerFromEnv } from "../src/provider.js";
import { KnowledgeBase } from "../src/knowledge.js";
import { ComponentRegistry } from "../src/registry.js";
import type { Candidate } from "../src/types.js";

const tmp = () => mkdtempSync(join(tmpdir(), "fe-"));
const MIT = `MIT License

Copyright (c) 2020 Example Author

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction.

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED.`;

test("intake: founder idea becomes a structured spec with a capability", () => {
  const spec = intakeDeterministic(readFileSync("fixtures/founder-idea.txt", "utf8"));
  assert.equal(spec.schema_version, "1.0.0");
  assert.equal(spec.stage, "idea");
  assert.deepEqual(spec.capabilities.map((c) => c.id), ["natural-language-date-parsing"]);
  assert.ok(spec.constraints.includes("founder is non-technical"));
  assert.ok(spec.open_questions.length > 0);
});

test("intake: vague input yields no capability and asks questions instead of guessing", () => {
  const spec = intakeDeterministic("I want to do something big.");
  assert.equal(spec.capabilities.length, 0);
  assert.ok(spec.open_questions.some((q) => /most important thing/.test(q)));
});

test("discovery: republished and forked copies are not eligible; non-MIT flagged", () => {
  const c = (name: string, repo: string | null, license = "MIT"): Candidate => ({
    name, version: "1.0.0", declaredLicense: license, repositoryUrl: normalizeRepoUrl(repo), description: "", score: 1, scoped: name.startsWith("@"),
  });
  const ranked = rankCandidates([
    c("chrono-node", "git+https://github.com/wanasit/chrono.git"),
    c("@x/chrono-node", "git+https://github.com/wanasit/chrono.git"),
    c("@y/chrono-node", "git+https://github.com/someone/chrono.git"),
    c("gpl-thing", "https://github.com/a/b", "GPL-3.0"),
    c("no-repo", null),
  ]);
  assert.deepEqual(ranked.filter((r) => r.eligible).map((r) => r.name), ["chrono-node"]);
});

test("compat: semver range checks used by engines fields", () => {
  assert.ok(satisfies("22.1.0", "^12.20.0 || ^14.13.1 || >=16.0.0"));
  assert.ok(!satisfies("14.0.0", "^12.20.0 || ^14.13.1 || >=16.0.0"));
  assert.ok(satisfies("20.5.0", ">=20"));
  assert.ok(!satisfies("18.0.0", ">=20"));
  assert.ok(satisfies("1.2.9", "~1.2.0") && !satisfies("1.3.0", "~1.2.0"));
});

test("license: clause check rejects text that merely says MIT", () => {
  assert.ok(hasMitClauses(MIT));
  assert.ok(!hasMitClauses("This project is MIT licensed. See badge."));
});

test("license: tarball without upstream evidence is not compatible", async () => {
  const files = new Map([
    ["package/package.json", Buffer.from(JSON.stringify({ license: "MIT" }))],
    ["package/LICENSE", Buffer.from(MIT)],
  ]);
  const f = await verifyLicense(files, null, null);
  assert.equal(f.spdx, "MIT");
  assert.equal(f.compatibleWithProject, false);
  assert.ok(f.problems.some((p) => /cannot compare against upstream/.test(p)));
});

test("license: declared MIT with non-MIT text is a problem", async () => {
  const files = new Map([
    ["package/package.json", Buffer.from(JSON.stringify({ license: "MIT" }))],
    ["package/LICENSE", Buffer.from("All rights reserved.")],
  ]);
  const f = await verifyLicense(files, null, null);
  assert.ok(f.problems.some((p) => /lacks required MIT clauses/.test(p)));
  assert.equal(f.compatibleWithProject, false);
});

test("tar: reads files from a real npm-style tgz", () => {
  const dir = tmp();
  mkdirSync(join(dir, "package"));
  writeFileSync(join(dir, "package", "LICENSE"), MIT);
  writeFileSync(join(dir, "package", "package.json"), '{"license":"MIT"}');
  execFileSync("tar", ["-czf", join(dir, "p.tgz"), "-C", dir, "package"]);
  const files = readTgz(readFileSync(join(dir, "p.tgz")));
  assert.equal(normalizeLicense(files.get("package/LICENSE")!.toString()), normalizeLicense(MIT));
});

test("evidence: chain verifies and detects tampering", () => {
  const p = join(tmp(), "e.jsonl");
  const log = new EvidenceLog(p);
  log.record("a", "s", "PASS", { x: 1 }, { y: 2 });
  log.record("b", "s", "PASS", {}, {});
  assert.deepEqual(log.verifyChain(), []);
  writeFileSync(p, readFileSync(p, "utf8").replace('"PASS"', '"FAIL"'));
  assert.ok(new EvidenceLog(p).verifyChain().some((m) => /tampered/.test(m)));
});

test("acceptance: chrono-node passes every calendar-derived case", () => {
  const results = runChronoAcceptance();
  for (const r of results) assert.equal(r.actual, r.expected, `${r.caseId}: ${r.input}`);
});

test("product: action items extracted with owners and due dates", () => {
  const items = extractActionItems(readFileSync("fixtures/meeting-notes.txt", "utf8"), new Date("2026-11-15T12:00:00Z"));
  assert.equal(items.length, 6);
  assert.deepEqual(items[0], { text: "follow up with the printer next Friday", owner: "Dana", due: "2026-11-20", dueSource: "next Friday" });
  assert.ok(!items.some((i) => /pricing tiers|hiring/.test(i.text)));
});

test("registry: status transitions are recorded with evidence", () => {
  const reg = new ComponentRegistry(join(tmp(), "r.json"));
  reg.upsert({ name: "x", version: "1.0.0", capability: "c", repository: null, upstreamAuthor: null, license: null, pinnedCommit: null, integrity: null, status: "Proposed", statusReason: "", evidence: [] });
  reg.setStatus("x", "Blocked", "license mismatch", "abc");
  const e = new ComponentRegistry(reg.path).get("x")!;
  assert.equal(e.status, "Blocked");
  assert.deepEqual(e.evidence, ["abc"]);
  assert.equal(reg.search("blocked").length, 1);
});

test("provider: OpenAI-compatible adapter talks real HTTP; knowledge retrieval feeds context", async () => {
  let seen: { model: string; messages: { role: string; content: string }[] } | null = null;
  let auth: string | undefined;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen = JSON.parse(body);
      auth = req.headers.authorization;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "It uses chrono-node [1]." } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const provider = new OpenAICompatibleProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, model: "test-model", apiKey: "k" });
    const kb = new KnowledgeBase(join(tmp(), "kb.json"));
    kb.upsert({ id: "c", title: "Component chrono-node", body: "date parsing component MIT", source: "receipt#1", evidence: [] });
    kb.upsert({ id: "d", title: "Unrelated", body: "pricing notes", source: "notes", evidence: [] });
    const { answer, sources } = await kb.ask("which date parsing component?", provider);
    assert.equal(answer, "It uses chrono-node [1].");
    assert.deepEqual(sources, ["receipt#1"]);
    assert.equal(seen!.model, "test-model");
    assert.equal(auth, "Bearer k");
    assert.match(seen!.messages[0].content, /chrono-node/);
  } finally {
    server.close();
  }
});

test("provider: LLM intake that returns junk falls back to deterministic extraction", async () => {
  const junk = { id: "junk", chat: async () => "not json" };
  const spec = await intakeWithProvider("I need deadline tracking", junk);
  assert.equal(spec.extraction_method, "deterministic-rules");
});

test("provider: unconfigured env yields no provider (no silent mock)", () => {
  assert.equal(providerFromEnv({}), null);
});

test("web: input validation and the extract endpoint", async () => {
  const { handleExtract, handleCurate, HttpError } = await import("../src/web.js");
  const r = handleExtract({ notes: "- Sam: send invoice tomorrow", ref: "2026-11-15" });
  assert.deepEqual(r.items[0], { text: "send invoice tomorrow", owner: "Sam", due: "2026-11-16", dueSource: "tomorrow" });
  assert.throws(() => handleExtract({ notes: "" }), HttpError);
  assert.throws(() => handleExtract({ notes: "x", ref: "15/11/2026" }), /YYYY-MM-DD/);
  await assert.rejects(handleCurate({ intent: "too short" }), /20-4000/);
});

test("intake: off-catalogue intents get a derived search capability", async () => {
  const { deriveCapability } = await import("../src/intake.js");
  const c = deriveCapability("I want an invoice generator that exports invoices to PDF for freelancers");
  assert.ok(c && c.id.startsWith("derived:") && /invoice/.test(c.searchQuery));
});

test("provenance: parses git smart-HTTP ref advertisement with peeled tags", async () => {
  const { parseRefAdvertisement } = await import("../src/provenance.js");
  const pkt = (s: string) => (s.length + 4).toString(16).padStart(4, "0") + s;
  const a = "a".repeat(40), b = "b".repeat(40);
  const body = pkt("# service=git-upload-pack\n") + "0000" + pkt(`${a} refs/tags/v1.0.0\0caps\n`) + pkt(`${b} refs/tags/v1.0.0^{}\n`) + "0000";
  const refs = parseRefAdvertisement(body);
  assert.equal(refs.get("refs/tags/v1.0.0"), a);
  assert.equal(refs.get("refs/tags/v1.0.0^{}"), b);
});

test("repo vetting: license classification, declarations, release-tag pinning", async () => {
  const { classifyLicense, classifyDeclaration, latestReleaseTag, normalizeGithubRepo } = await import("../src/repo-vetting.js");
  assert.equal(classifyLicense(MIT), "MIT");
  assert.equal(classifyLicense("GNU AFFERO GENERAL PUBLIC LICENSE Version 3, 19 November 2007"), "AGPL-3.0");
  assert.equal(classifyLicense("GNU GENERAL PUBLIC LICENSE Version 2, June 1991"), "GPL-2.0");
  assert.equal(classifyLicense("GNU LESSER GENERAL PUBLIC LICENSE Version 2.1, February 1999"), "LGPL-2.1");
  assert.equal(classifyLicense("Apache License Version 2.0, January 2004"), "Apache-2.0");
  assert.equal(classifyLicense("All rights reserved."), null);
  assert.equal(classifyDeclaration("The repo is released under [GPLv3 only](https://www.gnu.org/licenses/gpl-3.0.html) license."), "GPL-3.0");
  const a = "a".repeat(40), b = "b".repeat(40), c = "c".repeat(40);
  const refs = new Map([["refs/tags/v1.9.0", a], ["refs/tags/v1.10.0", b], ["refs/tags/v1.10.0^{}", c], ["refs/tags/nightly", a]]);
  assert.deepEqual(latestReleaseTag(refs), { tag: "v1.10.0", commit: c });
  assert.equal(normalizeGithubRepo("git+https://github.com/Owner/Repo.git"), "https://github.com/Owner/Repo");
});

// ---------- Milestone 2: pitch studio ----------
const sampleRun = () => JSON.parse(readFileSync("fixtures/sample-run.json", "utf8"));
const fixedProvider = (reply: string) => ({ id: "test", chat: async () => reply });

test("pitch: every script line cites facts, and no line contains a number absent from the evidence", async () => {
  const { buildScript, ungroundedNumbers } = await import("../src/pitch.js");
  const pack = { run: sampleRun(), founder: { ask: "Raising $150k pre-seed", assumptions: ["Price: $12 per team per month"] } };
  const { facts, script } = buildScript(pack);
  assert.ok(script.length >= 8);
  for (const l of script) {
    assert.ok(l.cites.length > 0, `uncited line: ${l.text}`);
    const cited = facts.filter((f) => l.cites.includes(f.id));
    assert.deepEqual(ungroundedNumbers(l.text, facts), [], `ungrounded number in: ${l.text}`);
    assert.ok(cited.length === l.cites.length);
  }
  assert.ok(script.some((l) => l.persona === "cfo" && /not a measured result/.test(l.text)));
});

test("pitch: with no founder assumptions the CFO says so instead of presenting figures", async () => {
  const { buildScript } = await import("../src/pitch.js");
  const cfo = buildScript({ run: sampleRun(), founder: {} }).script.filter((l) => l.persona === "cfo");
  assert.ok(cfo.some((l) => /No financial assumptions have been provided/.test(l.text)));
});

test("pitch: questions route to the right presenter and uncovered questions escalate", async () => {
  const { answerQuestion, routeQuestion } = await import("../src/pitch.js");
  assert.equal(routeQuestion("What's your burn rate?"), "cfo");
  assert.equal(routeQuestion("Which licences do the components use?"), "cto");
  assert.equal(routeQuestion("Why you, why now?"), "founder");
  const pack = { run: sampleRun(), founder: { assumptions: ["Price: $12 per team per month"] } };
  const price = await answerQuestion(pack, "What is your pricing?", null);
  assert.equal(price.persona, "cfo");
  assert.match(price.answer, /\$12/);
  const tam = await answerQuestion(pack, "What is the total addressable market?", null);
  assert.equal(tam.escalate, true);
  const lic = await answerQuestion(pack, "What open source licenses are you using?", null);
  assert.match(lic.answer, /chrono-node 2\.10\.3/);
});

test("pitch: an LLM answer with an invented number is rejected and replaced by evidence", async () => {
  const { answerQuestion } = await import("../src/pitch.js");
  const pack = { run: sampleRun(), founder: { assumptions: ["Price: $12 per team per month"] } };
  const a = await answerQuestion(pack, "What is your pricing?", fixedProvider("We charge $12 per team and already have 5,000 customers [F1]."));
  assert.equal(a.mode, "llm-rejected-fallback");
  assert.doesNotMatch(a.answer, /5,000|5000/);
  const ok = await answerQuestion(pack, "What is your pricing?", fixedProvider("Our working assumption is $12 per team per month [F" + "X]."));
  assert.equal(ok.mode, "llm-rejected-fallback"); // invalid citation id
});

test("pitch: a grounded LLM answer with valid citations is accepted; ESCALATE escalates", async () => {
  const { answerQuestion, buildFacts } = await import("../src/pitch.js");
  const pack = { run: sampleRun(), founder: { assumptions: ["Price: $12 per team per month"] } };
  const priceFact = buildFacts(pack).find((f) => f.kind === "assumption")!;
  const a = await answerQuestion(pack, "What is your pricing?", fixedProvider(`The founder's assumption is $12 per team per month [${priceFact.id}].`));
  assert.equal(a.mode, "llm-grounded");
  assert.deepEqual(a.cites, [priceFact.id]);
  const e = await answerQuestion(pack, "What is your pricing?", fixedProvider("ESCALATE"));
  assert.equal(e.escalate, true);
});

test("pitch: untrusted packs are validated", async () => {
  const { normalizePack } = await import("../src/pitch.js");
  assert.throws(() => normalizePack({ run: { spec: null } }), /curate result/);
  const p = normalizePack({ run: sampleRun(), founder: { assumptions: "a\nb\n\n", founder_name: "x".repeat(500) } });
  assert.deepEqual(p.founder.assumptions, ["a", "b"]);
  assert.equal(p.founder.founder_name!.length, 80);
});

test("investor lens: different investors get different emphasis, byte-identical facts", async () => {
  const { buildScript } = await import("../src/pitch.js");
  const pack = { run: sampleRun(), founder: { assumptions: ["Price: $12 per team per month"] } };
  const infra = buildScript(pack, { lens: { investor: "Infra fund", focus: ["technical"] } });
  const angel = buildScript(pack, { lens: { investor: "Marketplace angel", focus: ["financial", "market"] } });
  const none = buildScript(pack);
  assert.equal(infra.facts_hash, angel.facts_hash);
  assert.equal(infra.facts_hash, none.facts_hash);
  const firstNonFounder = (s: { persona: string }[]) => s.find((l) => l.persona !== "founder")!.persona;
  assert.equal(firstNonFounder(infra.script), "cto");
  assert.equal(firstNonFounder(angel.script), "cfo");
  const texts = (s: { text: string }[]) => s.map((l) => l.text).filter((t) => !/we've ordered this/.test(t)).sort();
  assert.deepEqual(texts(infra.script), texts(angel.script), "same statements, different order");
});

test("access gate: restricted founder facts only for verified accredited tokens; fails closed", async () => {
  const { buildFacts, answerQuestion } = await import("../src/pitch.js");
  const { issueAccess, verifyAccess } = await import("../src/access.js");
  const pack = { run: sampleRun(), founder: { assumptions: ["Price: $12 per team per month", "[restricted] Proprietary routing model cuts parse errors by 40%"] } };
  assert.ok(!buildFacts(pack).some((f) => /routing model/.test(f.text)));
  assert.ok(buildFacts(pack, "accredited").some((f) => f.restricted && /routing model/.test(f.text)));
  const secret = "s".repeat(40);
  const tok = issueAccess({ sub: "Jane <jane@acme.vc>", level: "accredited", verified_by: "provider ref 123", days: 7 }, secret);
  assert.equal(verifyAccess(tok, secret)?.level, "accredited");
  assert.equal(verifyAccess(tok, undefined), null, "no secret configured -> public");
  assert.equal(verifyAccess(tok, "x".repeat(40)), null, "wrong secret");
  assert.equal(verifyAccess(tok.replace(/.$/, (c) => (c === "A" ? "B" : "A")), secret), null, "tampered signature");
  assert.equal(verifyAccess(tok, secret, Date.now() + 8 * 86400_000), null, "expired");
  assert.throws(() => issueAccess({ sub: "x", level: "accredited", days: 1 }, "short"), /32 characters/);
  const pub = await answerQuestion(pack, "Tell me about the proprietary routing model", null, undefined, "public");
  assert.ok(!/40%/.test(pub.answer));
  const acc = await answerQuestion(pack, "Tell me about the proprietary routing model", null, undefined, "accredited");
  assert.match(acc.answer, /40%/);
});

test("web: pitch endpoint applies lens + access and reports gating status", async () => {
  const { handlePitch } = await import("../src/web.js");
  const { issueAccess } = await import("../src/access.js");
  const pack = { run: sampleRun(), founder: { assumptions: ["[restricted] Secret sauce detail"] } };
  delete process.env.FE_ACCESS_SECRET;
  const p0 = handlePitch({ pack, lens: { focus: ["technical"], investor: "X" } });
  assert.equal(p0.access, "public");
  assert.match(String(p0.access_note), /not configured/);
  process.env.FE_ACCESS_SECRET = "k".repeat(40);
  const tok = issueAccess({ sub: "Jane", level: "accredited", verified_by: "ref", days: 1 }, process.env.FE_ACCESS_SECRET);
  const p1 = handlePitch({ pack, access_token: tok });
  assert.equal(p1.access, "accredited");
  assert.ok(p1.facts.some((f: { restricted?: boolean }) => f.restricted));
  const p2 = handlePitch({ pack, access_token: "garbage.token" });
  assert.equal(p2.access, "public");
  assert.match(String(p2.access_note), /invalid or expired/);
  delete process.env.FE_ACCESS_SECRET;
});
