// HTTP-facing handlers, independent of any framework. api/*.js adapts them to Vercel functions.
// Each curate request runs the real pipeline in an isolated temp dir; nothing is mocked.
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runPipeline } from "./pipeline.js";
import { extractActionItems } from "./product/actionItems.js";
import { EvidenceLog, detectRunner } from "./evidence.js";
import { vetRepo } from "./repo-vetting.js";
import { normalizePack, buildScript, answerQuestion, PERSONAS, type Persona, type InvestorLens, type Focus } from "./pitch.js";
import { verifyAccess } from "./access.js";
import { providerFromEnv } from "./provider.js";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function str(v: unknown, field: string, min: number, max: number, optional = false): string | undefined {
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

export async function handleVetRepos(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(b.repos) || b.repos.length === 0 || b.repos.length > 15) throw new HttpError(400, "repos must be an array of 1-15 GitHub owner/repo strings");
  const repos = b.repos.map((r, i) => str(r, `repos[${i}]`, 3, 200)!);
  const log = new EvidenceLog(join(mkdtempSync(join(tmpdir(), "fe-vet-")), "evidence.jsonl"));
  const results = await Promise.all(repos.map(async (r) => {
    try {
      return await vetRepo(r);
    } catch (e) {
      return { repo: r, status: "Blocked" as const, problems: [(e as Error).message] };
    }
  }));
  for (const v of results) log.record("repo-vetting", v.repo, v.status === "Proposed" ? "PASS" : "FAIL", {}, v);
  return { runner: detectRunner(), results, receipts: log.all(), chain_intact: log.verifyChain().length === 0 };
}

export function packFrom(b: Record<string, unknown>) {
  if (JSON.stringify(b.pack ?? null).length > 400_000) throw new HttpError(413, "pack too large");
  try {
    return normalizePack(b.pack);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
}

export function accessFrom(b: Record<string, unknown>) {
  const claims = verifyAccess(typeof b.access_token === "string" ? b.access_token : null, process.env.FE_ACCESS_SECRET);
  return { level: claims?.level ?? ("public" as const), viewer: claims ? { sub: claims.sub, level: claims.level, verified_by: claims.verified_by ?? null, expires: new Date(claims.exp * 1000).toISOString() } : null, token_supplied: typeof b.access_token === "string" && b.access_token.length > 0 };
}

export function lensFrom(b: Record<string, unknown>): InvestorLens | undefined {
  const l = (b.lens ?? null) as Record<string, unknown> | null;
  if (!l) return undefined;
  const focus = (Array.isArray(l.focus) ? l.focus : []).filter((f): f is Focus => ["technical", "market", "financial"].includes(String(f)));
  if (!focus.length) return undefined;
  return { focus, investor: str(l.investor, "lens.investor", 1, 120, true), basis: str(l.basis, "lens.basis", 1, 300, true) };
}

export function handlePitch(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const pack = packFrom(b);
  const acc = accessFrom(b);
  const out = buildScript(pack, { lens: lensFrom(b), access: acc.level });
  return {
    ...out,
    personas: PERSONAS,
    founder: pack.founder,
    viewer: acc.viewer,
    access_note: acc.token_supplied && !acc.viewer ? "access token invalid or expired: showing public facts only" : process.env.FE_ACCESS_SECRET ? null : "access gating not configured on this deployment: restricted facts are never served",
    llm: providerFromEnv() ? "configured" : "not configured (evidence-retrieval answers)",
  };
}

export async function handleAsk(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const pack = packFrom(b);
  const question = str(b.question, "question", 3, 500)!;
  const persona = b.persona === undefined || b.persona === null || b.persona === "" ? undefined : String(b.persona);
  if (persona && !(persona in PERSONAS)) throw new HttpError(400, "persona must be founder, cto or cfo");
  return answerQuestion(pack, question, providerFromEnv(), persona as Persona | undefined, accessFrom(b).level);
}
