// HTTP-facing handlers, independent of any framework. api/*.js adapts them to Vercel functions.
// Each curate request runs the real pipeline in an isolated temp dir; nothing is mocked.
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runPipeline } from "./pipeline.js";
import { extractActionItems } from "./product/actionItems.js";
import { EvidenceLog, detectRunner } from "./evidence.js";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function str(v: unknown, field: string, min: number, max: number, optional = false): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (optional) return undefined;
    throw new HttpError(400, `${field} is required`);
  }
  if (typeof v !== "string") throw new HttpError(400, `${field} must be a string`);
  const t = v.trim();
  if (t.length < min || t.length > max) throw new HttpError(400, `${field} must be ${min}-${max} characters`);
  return t;
}

export async function handleCurate(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const intent = str(b.intent, "intent", 20, 4000)!;
  const notes = str(b.notes, "notes", 1, 20000, true);
  const stateDir = mkdtempSync(join(tmpdir(), "fe-run-"));
  const log: string[] = [];
  const out = await runPipeline({
    projectRoot: PROJECT_ROOT,
    founderInput: intent,
    sampleNotes: notes,
    stateDir,
    log: (m) => log.push(m),
  });
  const read = (f: string) => (existsSync(join(stateDir, f)) ? JSON.parse(readFileSync(join(stateDir, f), "utf8")) : null);
  const runner = detectRunner();
  const receipts = new EvidenceLog(join(stateDir, "evidence", `${runner}.jsonl`)).all();
  return {
    run_id: stateDir.split("fe-run-")[1],
    runner,
    engine_commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    status: out.status,
    status_reason: out.statusReason,
    selected: out.selected,
    spec: out.spec,
    registry: read("registry.json") ?? [],
    knowledge: read("knowledge.json") ?? [],
    artifact: read("artifacts/action-items.json"),
    receipts,
    chain_intact: out.chainProblems.length === 0,
    log,
  };
}

export function handleExtract(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const notes = str(b.notes, "notes", 1, 20000)!;
  const ref = str(b.ref, "ref", 10, 10, true);
  if (ref && !/^\d{4}-\d{2}-\d{2}$/.test(ref)) throw new HttpError(400, "ref must be YYYY-MM-DD");
  const reference = ref ? new Date(`${ref}T12:00:00Z`) : new Date();
  return { reference_date: reference.toISOString().slice(0, 10), items: extractActionItems(notes, reference) };
}

export function handleHealth() {
  const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"));
  return {
    ok: true,
    engine: pkg.name,
    version: pkg.version,
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    runner: detectRunner(),
    node: process.versions.node,
    pinned_components: pkg.dependencies,
  };
}
