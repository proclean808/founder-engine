// End-to-end acceptance pipeline:
// Founder input -> structured spec -> repository discovery -> license verification ->
// pinned integration -> executable test -> evidence receipt -> usable artifact
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { intakeDeterministic, intakeWithProvider } from "./intake.js";
import { providerFromEnv } from "./provider.js";
import { rankCandidates, searchRegistry, type RankedCandidate } from "./discovery.js";
import { verifyProvenance } from "./provenance.js";
import { readTgz } from "./tar.js";
import { verifyLicense } from "./license.js";
import { checkCompat } from "./compat.js";
import { runChronoAcceptance, REFERENCE_DATE } from "./acceptance.js";
import { EvidenceLog, detectRunner } from "./evidence.js";
import { ComponentRegistry } from "./registry.js";
import { KnowledgeBase } from "./knowledge.js";
import { extractActionItems, toMarkdown } from "./product/actionItems.js";
import { renderWorkspace } from "./workspace.js";
import type { ComponentStatus, VentureSpec } from "./types.js";

/** Components with a written integration adapter + acceptance suite. */
const ADAPTERS: Record<string, { acceptance: () => ReturnType<typeof runChronoAcceptance> }> = {
  "chrono-node": { acceptance: runChronoAcceptance },
};

export interface PipelineOptions {
  projectRoot: string;
  founderInputPath: string;
  sampleNotesPath: string;
  stateDir?: string;
  log?: (msg: string) => void;
}

export interface PipelineOutcome {
  spec: VentureSpec;
  selected: string | null;
  status: ComponentStatus | "NoCandidate";
  statusReason: string;
  receipts: number;
  chainProblems: string[];
  artifactPath: string | null;
  workspacePath: string;
}

export async function runPipeline(opts: PipelineOptions): Promise<PipelineOutcome> {
  const log = opts.log ?? (() => {});
  const stateDir = opts.stateDir ?? join(opts.projectRoot, "state");
  const runner = detectRunner();
  const evidence = new EvidenceLog(join(stateDir, "evidence", `${runner}.jsonl`));
  const registry = new ComponentRegistry(join(stateDir, "registry.json"));
  const kb = new KnowledgeBase(join(stateDir, "knowledge.json"));
  const projectPkg = JSON.parse(readFileSync(join(opts.projectRoot, "package.json"), "utf8"));

  // 1. Founder input -> structured spec
  const founderInput = readFileSync(opts.founderInputPath, "utf8");
  const provider = providerFromEnv();
  const spec = provider ? await intakeWithProvider(founderInput, provider) : intakeDeterministic(founderInput);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "venture-spec.json"), JSON.stringify(spec, null, 2) + "\n");
  const rSpec = evidence.record("intake", spec.venture_name, "INFO", { founder_input: founderInput }, spec);
  kb.upsert({
    id: "venture-spec",
    title: `Venture spec: ${spec.venture_name}`,
    body: `${spec.problem}\nStage: ${spec.stage}\nTarget user: ${spec.target_user ?? "unknown"}\nCapabilities: ${spec.capabilities
      .map((c) => c.id)
      .join(", ")}\nConstraints: ${spec.constraints.join(", ") || "none stated"}\nOpen questions: ${spec.open_questions.join(" ")}`,
    source: "state/venture-spec.json",
    evidence: [rSpec.receipt_hash],
  });
  log(`intake: ${spec.venture_name} (${spec.extraction_method}); capabilities=${spec.capabilities.map((c) => c.id).join(",")}`);

  const capability = spec.capabilities[0];
  let selected: RankedCandidate | null = null;
  let status: PipelineOutcome["status"] = "NoCandidate";
  let statusReason = "no capability identified; founder must answer open questions";

  if (capability) {
    // 2. Repository discovery
    const ranked = rankCandidates(await searchRegistry(capability));
    evidence.record("discovery", capability.id, "INFO", { query: capability.searchQuery }, ranked);
    log(`discovery: ${ranked.length} candidates, ${ranked.filter((r) => r.eligible).length} eligible`);
    for (const c of ranked.filter((r) => r.eligible).slice(0, 3)) {
      if (!registry.get(c.name)) {
        registry.upsert({
          name: c.name, version: c.version, capability: capability.id, repository: c.repositoryUrl,
          upstreamAuthor: null, license: c.declaredLicense, pinnedCommit: null, integrity: null,
          status: "Proposed", statusReason: "eligible on declared metadata (unverified)", evidence: [],
        });
      }
    }
    selected = ranked.find((r) => r.eligible && ADAPTERS[r.name]) ?? null;
    if (!selected) {
      statusReason = "eligible candidates found but none has an integration adapter yet";
    } else {
      const pin: string | undefined = projectPkg.dependencies?.[selected.name];
      // 3. Authorization gate: a dependency enters only via a committed exact pin.
      if (!pin) {
        status = "Proposed";
        statusReason = `awaiting authorization: add exact pin for ${selected.name} to package.json`;
        registry.setStatus(selected.name, "Proposed", statusReason);
      } else {
        // 4. Provenance + license verification against the pinned version
        const { provenance, meta, tarball } = await verifyProvenance(selected.name, pin);
        const files = readTgz(tarball);
        const lic = await verifyLicense(files, provenance.repository, provenance.gitHead);
        const compat = await checkCompat(selected.name, pin, provenance.integrity, meta.engines?.node, opts.projectRoot);
        const provProblems = [
          ...(provenance.tarballSha512Matches ? [] : ["tarball sha512 does not match registry integrity"]),
          ...(provenance.gitHeadMatchesTag ? [] : ["registry gitHead does not match upstream release tag"]),
        ];
        const author =
          (typeof meta.author === "string" ? meta.author : meta.author?.name) ??
          lic.copyrightLine?.replace(/^copyright\s*(\(c\)|©)?\s*[\d,\- ]*/i, "").trim() ??
          null;
        const rProv = evidence.record("provenance", `${selected.name}@${pin}`, provProblems.length ? "FAIL" : "PASS", { pin }, { ...provenance, problems: provProblems });
        const { licenseText, ...licSummary } = lic;
        const rLic = evidence.record("license", `${selected.name}@${pin}`, lic.compatibleWithProject ? "PASS" : "FAIL", { repository: provenance.repository, commit: provenance.gitHead }, licSummary);
        const rCompat = evidence.record("compatibility", `${selected.name}@${pin}`, compat.problems.length ? "FAIL" : "PASS", { pin }, compat);
        registry.upsert({
          name: selected.name, version: pin, capability: capability.id, repository: provenance.repository,
          upstreamAuthor: author, license: lic.spdx, pinnedCommit: provenance.gitHead, integrity: provenance.integrity,
          status: "Proposed", statusReason: "checks running", evidence: [rProv.receipt_hash, rLic.receipt_hash, rCompat.receipt_hash],
        });
        log(`provenance: ${provProblems.length ? provProblems.join("; ") : "ok"} | license: ${lic.spdx ?? "?"} ${lic.problems.join("; ") || "ok"} | compat: ${compat.problems.join("; ") || "ok"}`);

        const blockers = [...provProblems, ...lic.problems, ...compat.problems];
        if (blockers.length) {
          status = "Blocked";
          statusReason = blockers.join("; ");
          registry.setStatus(selected.name, "Blocked", statusReason);
        } else {
          registry.setStatus(selected.name, "Integrated", "pinned; provenance, license and compatibility checks passed");
          writeNotices(opts.projectRoot, selected.name, pin, provenance.repository, provenance.gitHead, lic.copyrightLine, licenseText);

          // 5. Executable acceptance test
          const results = ADAPTERS[selected.name].acceptance();
          const passed = results.every((r) => r.pass);
          const rTest = evidence.record("acceptance", `${selected.name}@${pin}`, passed ? "PASS" : "FAIL", { reference_date: REFERENCE_DATE }, results);
          if (!passed) {
            status = "Blocked";
            statusReason = `acceptance failed: ${results.filter((r) => !r.pass).map((r) => r.caseId).join(", ")}`;
          } else if (runner === "ci") {
            status = "Verified";
            statusReason = `${results.length}/${results.length} acceptance cases passed on independent CI runner`;
          } else {
            status = "Tested";
            statusReason = `${results.length}/${results.length} acceptance cases passed locally; Verified requires a clean CI run`;
          }
          registry.setStatus(selected.name, status, statusReason, rTest.receipt_hash);
          log(`acceptance: ${results.filter((r) => r.pass).length}/${results.length} -> ${status}`);

          // 6. Knowledge base: component record + test evidence
          kb.upsert({
            id: `component:${selected.name}`,
            title: `Component ${selected.name}@${pin} (${status})`,
            body: `Capability: ${capability.description}. License ${lic.spdx} (${lic.copyrightLine ?? "no copyright line"}). Upstream ${provenance.repository} at commit ${provenance.gitHead}. Acceptance: ${results
              .map((r) => `${r.caseId} expected ${r.expected} got ${r.actual} ${r.pass ? "PASS" : "FAIL"}`)
              .join("; ")}. Status reason: ${statusReason}`,
            source: `state/evidence/${runner}.jsonl#${rTest.receipt_hash}`,
            evidence: [rProv.receipt_hash, rLic.receipt_hash, rCompat.receipt_hash, rTest.receipt_hash],
          });
        }
      }
    }
  }

  // 7. Usable artifact (only when the component cleared integration)
  let artifactPath: string | null = null;
  if (status === "Tested" || status === "Verified") {
    const notes = readFileSync(opts.sampleNotesPath, "utf8");
    const items = extractActionItems(notes, new Date(REFERENCE_DATE));
    const dir = join(stateDir, "artifacts");
    mkdirSync(dir, { recursive: true });
    artifactPath = join(dir, "action-items.md");
    writeFileSync(artifactPath, `# Action items (reference date ${REFERENCE_DATE.slice(0, 10)})\n\n${toMarkdown(items)}\n`);
    writeFileSync(join(dir, "action-items.json"), JSON.stringify(items, null, 2) + "\n");
    const rArt = evidence.record("artifact", "action-items", items.length ? "PASS" : "FAIL", { notes }, items);
    kb.upsert({
      id: "artifact:action-items",
      title: "Generated artifact: action items from sample meeting notes",
      body: toMarkdown(items),
      source: "state/artifacts/action-items.md",
      evidence: [rArt.receipt_hash],
    });
    log(`artifact: ${items.length} action items -> ${artifactPath}`);
  }

  const chainProblems = evidence.verifyChain();
  evidence.record("summary", spec.venture_name, chainProblems.length === 0 ? "INFO" : "FAIL", {}, {
    selected: selected?.name ?? null, status, statusReason, chain_problems: chainProblems,
  });

  const workspacePath = join(stateDir, "workspace.html");
  writeFileSync(workspacePath, renderWorkspace({ spec, registry: registry.list(), receipts: evidence.all(), knowledge: kb.list(), artifactPath, status, statusReason }));

  return { spec, selected: selected?.name ?? null, status, statusReason, receipts: evidence.all().length, chainProblems, artifactPath, workspacePath };
}

function writeNotices(root: string, name: string, version: string, repo: string | null, commit: string | null, copyright: string | null, text: string | null) {
  const body = [
    "# Third-party notices",
    "",
    "Generated by the founder-engine pipeline from the license file shipped in each pinned tarball.",
    "",
    `## ${name}@${version}`,
    "",
    `- Upstream: ${repo ?? "unknown"}`,
    `- Commit: ${commit ?? "unknown"}`,
    `- ${copyright ?? "No copyright line found"}`,
    "",
    "```",
    text ?? "",
    "```",
    "",
  ].join("\n");
  writeFileSync(join(root, "THIRD_PARTY_NOTICES.md"), body);
}
