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
  founderInputPath?: string;
  founderInput?: string;
  sampleNotesPath?: string;
  sampleNotes?: string;
  stateDir?: string;
  vetTop?: number; // how many eligible candidates get provenance + license vetting (default 3)
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
  const founderInput = opts.founderInput ?? readFileSync(opts.founderInputPath ?? join(opts.projectRoot, "fixtures/founder-idea.txt"), "utf8");
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

  let capability = spec.capabilities[0];
  let selected: RankedCandidate | null = null;
  let status: PipelineOutcome["status"] = "NoCandidate";
  let statusReason = "no capability identified; founder must answer open questions";

  if (capability) {
    // 2. Repository discovery, one search per building-block capability
    const caps = spec.capabilities.slice(0, 4);
    const discovered = await Promise.all(caps.map(async (cap) => {
      const ranked = rankCandidates(await searchRegistry(cap));
      evidence.record("discovery", cap.id, "INFO", { query: cap.searchQuery }, ranked);
      return { cap, ranked };
    }));
    for (const d of discovered) {
      log(`discovery[${d.cap.id}]: ${d.ranked.length} candidates, ${d.ranked.filter((r) => r.eligible).length} eligible`);
      const withAdapter = d.ranked.find((r) => r.eligible && ADAPTERS[r.name]);
      if (!selected && withAdapter) {
        selected = withAdapter;
        capability = d.cap;
      }
    }
    // Curation: vet the top eligible candidates per capability (provenance + license), adapter or not.
    const perCap = opts.vetTop ?? (caps.length > 1 ? 2 : 3);
    const toVet = discovered.flatMap((d) => d.ranked.filter((r) => r.eligible && r.name !== selected?.name).slice(0, perCap).map((c) => ({ c, cap: d.cap })));
    const vetted = await Promise.all(toVet.map(async ({ c, cap }) => {
      try {
        const { provenance, meta, tarball } = await verifyProvenance(c.name, c.version);
        const lic = await verifyLicense(readTgz(tarball), provenance.repository, provenance.gitHead);
        return { c, cap, provenance, meta, lic, error: null as string | null };
      } catch (e) {
        return { c, cap, provenance: null, meta: null, lic: null, error: (e as Error).message };
      }
    }));
    let vettedOk = 0;
    for (const v of vetted) {
      const problems = v.error ? [v.error] : [...vettingProvenanceProblems(v.provenance!, v.lic!.upstreamLicenseUrl), ...v.lic!.problems];
      if (!problems.length) vettedOk++;
      const { licenseText: _t, ...licSummary } = v.lic ?? { licenseText: null };
      const basis = v.provenance?.gitHeadMatchesTag ? "release tag" : "commit present upstream";
      const r = evidence.record("vetting", `${v.c.name}@${v.c.version}`, problems.length ? "FAIL" : "PASS", { candidate: v.c.name, version: v.c.version, capability: v.cap.id }, { provenance: v.provenance, provenance_basis: problems.length ? null : basis, license: v.lic ? licSummary : null, problems });
      const author = v.meta ? (typeof v.meta.author === "string" ? v.meta.author : v.meta.author?.name) ?? v.lic?.copyrightLine?.replace(/^copyright\s*(\(c\)|©)?\s*[\d,\- ]*/i, "").trim() ?? null : null;
      registry.upsert({
        name: v.c.name, version: v.c.version, capability: v.cap.id, repository: v.provenance?.repository ?? v.c.repositoryUrl,
        upstreamAuthor: author, license: v.lic?.spdx ?? null, pinnedCommit: v.provenance?.gitHead ?? null, integrity: v.provenance?.integrity ?? null,
        status: problems.length ? "Blocked" : "Proposed",
        statusReason: problems.length ? problems.join("; ") : `vetted (${basis}; ${v.lic!.spdx} text matches upstream); no integration adapter yet`,
        evidence: [r.receipt_hash],
      });
    }
    log(`vetting: ${vettedOk}/${vetted.length} candidates passed provenance + license`);
    if (!selected && vettedOk > 0) {
      status = "Proposed";
      statusReason = `${vettedOk} of ${vetted.length} candidates across ${caps.length} capabilit${caps.length > 1 ? "ies" : "y"} passed provenance + license vetting; an integration adapter is needed before assembly`;
    }
    if (!selected) {
      if (status === "NoCandidate") statusReason = "no candidate passed vetting; refine the intent or answer the open questions";
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
          writeNotices(stateDir, selected.name, pin, provenance.repository, provenance.gitHead, lic.copyrightLine, licenseText);

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
            statusReason = `${results.length}/${results.length} acceptance cases passed on ${runner} runner; Verified requires a clean CI run`;
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
    const notes = opts.sampleNotes ?? readFileSync(opts.sampleNotesPath ?? join(opts.projectRoot, "fixtures/meeting-notes.txt"), "utf8");
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

/**
 * Provenance for curation candidates: the tarball must match its registry hash and the recorded
 * commit must exist upstream (proved by a matching release tag, or by fetching the license file
 * at that commit). Integrated dependencies are held to the stricter release-tag rule above.
 */
export function vettingProvenanceProblems(p: { tarballSha512Matches: boolean; gitHead: string | null; tagCommit: string | null; gitHeadMatchesTag: boolean }, upstreamLicenseUrl: string | null): string[] {
  const out: string[] = [];
  if (!p.tarballSha512Matches) out.push("tarball sha512 does not match registry integrity");
  if (!p.gitHead) out.push("registry records no source commit (gitHead)");
  else if (p.tagCommit && !p.gitHeadMatchesTag) out.push("upstream release tag points at a different commit than the registry");
  else if (!p.tagCommit && !upstreamLicenseUrl) out.push("source commit not confirmed upstream");
  return out;
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
