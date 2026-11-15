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
