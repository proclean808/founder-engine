// Founder workspace: a single static HTML page rendered from real pipeline state.
// Nothing here is mocked; every row comes from state/ files.
import { existsSync, readFileSync } from "node:fs";
import type { RegistryEntry, VentureSpec } from "./types.js";
import type { Receipt } from "./evidence.js";
import type { KnowledgeDoc } from "./knowledge.js";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STATUS_COLOR: Record<string, string> = {
  Proposed: "#8a8f98", Integrated: "#3b82f6", Tested: "#d97706", Verified: "#16a34a", Blocked: "#dc2626",
  PASS: "#16a34a", FAIL: "#dc2626", INFO: "#8a8f98", NoCandidate: "#8a8f98",
};
const pill = (s: string) => `<span class="pill" style="background:${STATUS_COLOR[s] ?? "#555"}">${esc(s)}</span>`;

export function renderWorkspace(input: {
  spec: VentureSpec;
  registry: RegistryEntry[];
  receipts: Receipt[];
  knowledge: KnowledgeDoc[];
  artifactPath: string | null;
  status: string;
  statusReason: string;
}): string {
  const { spec, registry, receipts, knowledge, artifactPath, status, statusReason } = input;
  const artifact = artifactPath && existsSync(artifactPath.replace(/\.md$/, ".json"))
    ? (JSON.parse(readFileSync(artifactPath.replace(/\.md$/, ".json"), "utf8")) as { text: string; owner: string | null; due: string | null }[])
    : [];
  const acceptance = [...receipts].reverse().find((r) => r.kind === "acceptance");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Founder workspace — ${esc(spec.venture_name)}</title>
<style>
:root{color-scheme:dark;--bg:#0e1013;--card:#171a1f;--line:#262a31;--fg:#e6e8eb;--mute:#8a8f98}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:980px;margin:0 auto;padding:20px}h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:0 0 10px;color:var(--mute);text-transform:uppercase;letter-spacing:.06em}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:14px 0}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{color:var(--mute);font-weight:500}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;color:#fff;font-size:12px;font-weight:600}
code{font:12px ui-monospace,monospace;color:#c9d1d9;word-break:break-all}.mute{color:var(--mute)}
input{width:100%;padding:8px;background:#0b0d10;border:1px solid var(--line);border-radius:6px;color:var(--fg);margin-bottom:8px}
</style></head><body><main>
<h1>${esc(spec.venture_name)}</h1>
<div class="mute">Stage: ${esc(spec.stage)} · Intake: ${esc(spec.extraction_method)} · Milestone 1 status: ${pill(status)}</div>
<p>${esc(statusReason)}</p>

<section><h2>Venture spec</h2>
<p><b>Problem:</b> ${esc(spec.problem)}</p>
<p><b>Target user:</b> ${esc(spec.target_user ?? "unknown")}</p>
<p><b>Objective:</b> ${esc(spec.immediate_objective)}</p>
<p><b>Constraints:</b> ${esc(spec.constraints.join(", ") || "none stated")}</p>
<p><b>Open questions for founder:</b></p><ul>${spec.open_questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>
</section>

<section><h2>Working artifact — action items</h2>
${artifact.length ? `<table><tr><th>Action</th><th>Owner</th><th>Due</th></tr>${artifact
    .map((a) => `<tr><td>${esc(a.text)}</td><td>${esc(a.owner ?? "—")}</td><td>${esc(a.due ?? "—")}</td></tr>`)
    .join("")}</table><p class="mute">Run it yourself: <code>npm run extract -- your-notes.txt</code></p>`
    : `<p class="mute">No artifact: the component has not cleared integration.</p>`}
</section>

<section><h2>Component registry</h2>
<input id="q" placeholder="Search registry…" oninput="for(const r of document.querySelectorAll('#reg tr[data-s]'))r.style.display=r.dataset.s.includes(this.value.toLowerCase())?'':'none'">
<table id="reg"><tr><th>Component</th><th>Status</th><th>License</th><th>Pinned commit</th><th>Reason</th></tr>
${registry
    .map((e) => `<tr data-s="${esc(`${e.name} ${e.capability} ${e.license} ${e.status}`.toLowerCase())}"><td><b>${esc(e.name)}</b>@${esc(e.version)}<br><span class="mute">${esc(e.repository ?? "")}</span></td><td>${pill(e.status)}</td><td>${esc(e.license ?? "unverified")}</td><td><code>${esc(e.pinnedCommit?.slice(0, 12) ?? "—")}</code></td><td>${esc(e.statusReason)}</td></tr>`)
    .join("")}</table>
</section>

<section><h2>Acceptance test</h2>
${acceptance ? `<p>${pill(acceptance.result)} runner: <b>${esc(acceptance.environment.runner)}</b>, node ${esc(acceptance.environment.node)}, commit <code>${esc(acceptance.environment.repo_commit?.slice(0, 12) ?? "uncommitted")}</code>${acceptance.environment.ci_run_url ? ` · <a href="${esc(acceptance.environment.ci_run_url)}">CI run</a>` : ""}</p>
<table><tr><th>Case</th><th>Input</th><th>Expected</th><th>Actual</th><th></th></tr>${(acceptance.outputs as { caseId: string; input: string; expected: string | null; actual: string | null; pass: boolean }[])
    .map((r) => `<tr><td>${esc(r.caseId)}</td><td>${esc(r.input)}</td><td>${esc(r.expected ?? "null")}</td><td>${esc(r.actual ?? "null")}</td><td>${pill(r.pass ? "PASS" : "FAIL")}</td></tr>`)
    .join("")}</table>` : `<p class="mute">Not run.</p>`}
</section>

<section><h2>Evidence receipts (hash-chained)</h2>
<table><tr><th>#</th><th>Kind</th><th>Subject</th><th>Result</th><th>Hash</th></tr>
${receipts.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.kind)}</td><td>${esc(r.subject)}</td><td>${pill(r.result)}</td><td><code>${esc(r.receipt_hash.slice(0, 16))}</code></td></tr>`).join("")}
</table></section>

<section><h2>Venture knowledge base</h2>
<p class="mute">Retrieval context for the founder's chosen model. Not fine-tuning.</p>
<table><tr><th>Doc</th><th>v</th><th>Source</th></tr>${knowledge.map((d) => `<tr><td>${esc(d.title)}</td><td>${d.version}</td><td><code>${esc(d.source)}</code></td></tr>`).join("")}</table>
</section>
</main></body></html>
`;
}
