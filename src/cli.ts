#!/usr/bin/env node
// founder-engine CLI
//   run --input <founder-idea.txt> [--notes <notes.txt>]   full acceptance pipeline
//   intake <file>                                           print structured spec
//   extract <notes.txt> [--ref YYYY-MM-DD]                  the product: action items
//   ask "<question>"                                        RAG over venture knowledge (needs provider env)
//   verify-evidence [state/evidence/<runner>.jsonl]         recheck receipt hash chain
//   build-project --repo <url|path> --rev <rev> --work <dir> clone, build, test, package, run 2nd instance
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { runPipeline } from "./pipeline.js";
import { intakeDeterministic } from "./intake.js";
import { extractActionItems, toMarkdown } from "./product/actionItems.js";
import { KnowledgeBase } from "./knowledge.js";
import { providerFromEnv } from "./provider.js";
import { EvidenceLog, detectRunner } from "./evidence.js";
import { buildProject } from "./build-project.js";
import { vetRepo } from "./repo-vetting.js";
import { issueAccess } from "./access.js";
import { getDb, migrate, closeDb } from "./db.js";
import { writeFileSync } from "node:fs";

const [, , cmd, ...rest] = process.argv;
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const root = process.cwd();

async function main(): Promise<number> {
  switch (cmd) {
    case "run": {
      const out = await runPipeline({
        projectRoot: root,
        founderInputPath: resolve(flag("input") ?? "fixtures/founder-idea.txt"),
        sampleNotesPath: resolve(flag("notes") ?? "fixtures/meeting-notes.txt"),
        log: (m) => console.log(`• ${m}`),
      });
      console.log(`\nRESULT ${out.status}: ${out.statusReason}`);
      console.log(`receipts: ${out.receipts}  chain: ${out.chainProblems.length ? out.chainProblems.join("; ") : "intact"}`);
      console.log(`workspace: ${out.workspacePath}`);
      if (out.artifactPath) console.log(`artifact: ${out.artifactPath}`);
      return out.status === "Tested" || out.status === "Verified" ? 0 : 1;
    }
    case "intake":
      console.log(JSON.stringify(intakeDeterministic(readFileSync(rest[0], "utf8")), null, 2));
      return 0;
    case "extract": {
      const ref = flag("ref") ? new Date(`${flag("ref")}T12:00:00Z`) : new Date();
      const text = rest[0] && !rest[0].startsWith("--") ? readFileSync(rest[0], "utf8") : readFileSync(0, "utf8");
      console.log(toMarkdown(extractActionItems(text, ref)));
      return 0;
    }
    case "ask": {
      const provider = providerFromEnv();
      if (!provider) {
        console.error("No provider configured. Set FE_PROVIDER_BASE_URL and FE_PROVIDER_MODEL (and FE_PROVIDER_API_KEY if needed).");
        return 2;
      }
      const kb = new KnowledgeBase(join(root, "state", "knowledge.json"));
      const { answer, sources } = await kb.ask(rest.join(" "), provider);
      console.log(answer, "\n\nsources:", sources.join(", ") || "none");
      return 0;
    }
    case "verify-evidence": {
      const log = new EvidenceLog(resolve(rest[0] ?? `state/evidence/${detectRunner()}.jsonl`));
      const problems = log.verifyChain();
      console.log(problems.length ? problems.join("\n") : `chain intact (${log.all().length} receipts)`);
      return problems.length ? 1 : 0;
    }
    case "build-project": {
      const repo = flag("repo");
      const rev = flag("rev");
      const work = flag("work");
      if (!repo || !rev || !work) {
        console.error("usage: build-project --repo <url|path> --rev <commit|tag|branch> --work <empty dir>");
        return 2;
      }
      const report = buildProject({ repo, rev, workDir: work, log: (m) => console.log(`[depth ${process.env.FE_BUILD_DEPTH ?? 0}] ${m}`) });
      return report.verdict === "PASS" ? 0 : 1;
    }
    case "vet-repos": {
      // vet-repos <roster.txt | owner/repo ...> [--out results.json]
      const args = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--out");
      const list = args.length === 1 && args[0].endsWith(".txt")
        ? readFileSync(args[0], "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
        : args;
      if (!list.length) { console.error("usage: vet-repos <roster.txt | owner/repo ...> [--out file.json]"); return 2; }
      const log = new EvidenceLog(resolve(flag("out")?.replace(/\.json$/, ".evidence.jsonl") ?? "state/evidence/repo-vetting.jsonl"));
      const results = [];
      for (const r of list) {
        let v;
        try { v = await vetRepo(r); } catch (e) { console.log(`${r}: ERROR ${(e as Error).message}`); continue; }
        log.record("repo-vetting", v.repo, v.status === "Proposed" ? "PASS" : "FAIL", { input: r }, v);
        results.push(v);
        console.log(`${v.status.padEnd(8)} ${v.repo.replace("https://github.com/", "").padEnd(34)} ${(v.spdx ?? "-").padEnd(12)} ${v.reuse.padEnd(22)} ${(v.latestTag ?? v.defaultBranch ?? "-").padEnd(14)} ${(v.pinnedCommit ?? "").slice(0, 10)}  ${v.problems.join("; ")}`);
      }
      if (flag("out")) writeFileSync(resolve(flag("out")!), JSON.stringify(results, null, 2) + "\n");
      console.log(`\n${results.filter((r) => r.status === "Proposed").length}/${list.length} vetted · chain ${log.verifyChain().length ? "BROKEN" : "intact"}`);
      return 0;
    }
    case "migrate": {
      const applied = await migrate(getDb(), (m) => console.log(m));
      console.log(applied.length ? `applied ${applied.length} migration(s)` : "schema up to date");
      await closeDb();
      return 0;
    }
    case "issue-access": {
      // issue-access --investor "Jane Doe <jane@acme.vc>" --level accredited --days 7 --verified-by "Provider ref 123"
      const secret = process.env.FE_ACCESS_SECRET ?? "";
      const investor = flag("investor");
      const level = (flag("level") ?? "identified") as "identified" | "accredited";
      if (!investor) { console.error("usage: issue-access --investor <name/email> --level identified|accredited --days N --verified-by <provider ref>"); return 2; }
      if (level === "accredited" && !flag("verified-by")) { console.error("accredited access requires --verified-by <third-party verification reference>"); return 2; }
      console.log(issueAccess({ sub: investor, level, verified_by: flag("verified-by"), days: Number(flag("days") ?? 7) }, secret));
      return 0;
    }
    default:
      console.log("usage: founder-engine run|intake|extract|ask|verify-evidence|build-project|vet-repos|issue-access|migrate");
      return cmd ? 2 : 0;
  }
}

main().then((c) => process.exit(c), (e) => {
  console.error(e);
  process.exit(1);
});
