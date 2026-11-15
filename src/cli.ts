#!/usr/bin/env node
// founder-engine CLI
//   run --input <founder-idea.txt> [--notes <notes.txt>]   full acceptance pipeline
//   intake <file>                                           print structured spec
//   extract <notes.txt> [--ref YYYY-MM-DD]                  the product: action items
//   ask "<question>"                                        RAG over venture knowledge (needs provider env)
//   verify-evidence [state/evidence/local.jsonl]            recheck receipt hash chain
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { runPipeline } from "./pipeline.js";
import { intakeDeterministic } from "./intake.js";
import { extractActionItems, toMarkdown } from "./product/actionItems.js";
import { KnowledgeBase } from "./knowledge.js";
import { providerFromEnv } from "./provider.js";
import { EvidenceLog } from "./evidence.js";

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
      const log = new EvidenceLog(resolve(rest[0] ?? "state/evidence/local.jsonl"));
      const problems = log.verifyChain();
      console.log(problems.length ? problems.join("\n") : `chain intact (${log.all().length} receipts)`);
      return problems.length ? 1 : 0;
    }
    default:
      console.log("usage: founder-engine run|intake|extract|ask|verify-evidence");
      return cmd ? 2 : 0;
  }
}

main().then((c) => process.exit(c), (e) => {
  console.error(e);
  process.exit(1);
});
