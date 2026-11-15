// Generic project builder: the same interface for a founder's repository and for founder-engine itself.
//
//   source:   git fetch <repo> <rev> into an empty work dir, resolve the exact commit
//   manifest: read founder-engine.build.json FROM THAT REPO (versioned with the code it builds)
//   build:    run manifest.source_steps (install, build, test, package) with an isolated HOME and
//             npm cache, so dependencies are re-resolved from the lockfile, not reused from this host
//   package:  locate the tarball, hash it (sha512 SRI), list its files
//   instance: unpack the tarball into a second empty dir (no git, no source tree), run
//             manifest.instance_steps there (install from shipped lockfile, tests, acceptance)
//   record:   every command, exit code, duration and output hash as hash-chained receipts + a report
//
// Isolation is filesystem/process level (separate dirs, HOME, npm cache, env allowlist).
// It is NOT a container or VM sandbox: the repo's declared commands run with this user's permissions.
// Only build repositories you are authorized to execute.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readTgz } from "./tar.js";
import { sriSha512 } from "./provenance.js";
import { satisfies } from "./compat.js";
import { EvidenceLog } from "./evidence.js";

export const MANIFEST_FILE = "founder-engine.build.json";

export interface BuildStep {
  id: string;
  run: string[]; // argv, no shell. Supports {{repo}} {{rev}} {{work}} {{depth}}
  max_depth?: number; // run only when current build depth < max_depth (bounds recursion)
  timeout_s?: number;
}

export interface BuildManifest {
  schema_version: "1.0.0";
  name: string;
  engines?: { node?: string };
  source_steps: BuildStep[];
  package: { tarball_from_step: string }; // step whose stdout is `npm pack --json`
  instance_steps: BuildStep[];
  reproducibility?: { compare_child_report?: string }; // path (templated) to a child build report
}

export interface StepRecord {
  phase: "source" | "instance";
  id: string;
  argv: string[];
  cwd: string;
  exit_code: number | null;
  signal: string | null;
  duration_ms: number;
  stdout_sha256: string;
  stderr_sha256: string;
  output_tail: string;
  skipped?: string;
}

export interface BuildReport {
  schema_version: "1.0.0";
  verdict: "PASS" | "FAIL";
  failure: string | null;
  repo: string;
  requested_rev: string;
  resolved_commit: string | null;
  depth: number;
  node: string;
  work_dir: string;
  manifest: BuildManifest | null;
  steps: StepRecord[];
  package: { file: string; integrity: string; size: number; files: string[] } | null;
  instance_dir: string | null;
  reproducibility: { child_report: string; child_integrity: string | null; identical: boolean } | null;
  evidence_log: string;
  started_at: string;
  finished_at: string;
}

// Environment allowlist for executed steps. Credentials (tokens, cloud keys, npm auth) never pass.
const ENV_ALLOW = [
  "PATH", "LANG", "TZ", "TERM",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "GIT_SSL_CAINFO",
  "npm_config_https_proxy", "npm_config_proxy", "npm_config_noproxy",
  "GITHUB_ACTIONS", "GITHUB_SERVER_URL", "GITHUB_REPOSITORY", "GITHUB_RUN_ID",
  "FE_NPM_REGISTRY",
];

export function isolatedEnv(work: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ENV_ALLOW) if (process.env[k] !== undefined) env[k] = process.env[k];
  const home = join(work, "home");
  mkdirSync(home, { recursive: true });
  return {
    ...env,
    HOME: home,
    npm_config_cache: join(work, "npm-cache"),
    npm_config_userconfig: join(home, ".npmrc"),
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  };
}

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

function template(argv: string[], vars: Record<string, string>): string[] {
  return argv.map((a) => a.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`unknown template variable {{${k}}}`);
    return vars[k];
  }));
}

function exec(phase: StepRecord["phase"], id: string, argv: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutS = 900): StepRecord & { stdout: string } {
  const t0 = Date.now();
  const r = spawnSync(argv[0], argv.slice(1), { cwd, env, encoding: "utf8", timeout: timeoutS * 1000, maxBuffer: 64 * 1024 * 1024 });
  const stdout = r.stdout ?? "";
  const stderr = (r.stderr ?? "") + (r.error ? `\n${r.error.message}` : "");
  return {
    phase, id, argv, cwd,
    exit_code: r.status,
    signal: r.signal,
    duration_ms: Date.now() - t0,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    output_tail: (stdout + stderr).slice(-1500),
    stdout,
  };
}

export function validateManifest(m: unknown): BuildManifest {
  const x = m as BuildManifest;
  const bad = (why: string) => { throw new Error(`invalid ${MANIFEST_FILE}: ${why}`); };
  if (!x || x.schema_version !== "1.0.0") bad("schema_version must be 1.0.0");
  if (!Array.isArray(x.source_steps) || !Array.isArray(x.instance_steps)) bad("source_steps and instance_steps required");
  for (const s of [...x.source_steps, ...x.instance_steps]) {
    if (!s.id || !Array.isArray(s.run) || s.run.length === 0 || !s.run.every((a) => typeof a === "string")) bad(`step ${s.id ?? "?"} needs id and argv array`);
  }
  if (!x.package?.tarball_from_step || !x.source_steps.some((s) => s.id === x.package.tarball_from_step)) bad("package.tarball_from_step must name a source step");
  return x;
}

export interface BuildOptions {
  repo: string; // URL or local path to a git repository
  rev: string; // commit, tag or branch
  workDir: string; // must not exist or be empty
  depth?: number;
  log?: (m: string) => void;
}

export function buildProject(opts: BuildOptions): BuildReport {
  const log = opts.log ?? (() => {});
  const work = resolve(opts.workDir);
  if (existsSync(work) && readdirSync(work).length > 0) throw new Error(`work dir ${work} is not empty`);
  mkdirSync(work, { recursive: true });
  const depth = opts.depth ?? Number(process.env.FE_BUILD_DEPTH ?? 0);
  const repo = /^[a-z]+:\/\//i.test(opts.repo) ? opts.repo : resolve(opts.repo);
  const evidence = new EvidenceLog(join(work, "evidence.jsonl"));
  const report: BuildReport = {
    schema_version: "1.0.0", verdict: "FAIL", failure: null, repo, requested_rev: opts.rev, resolved_commit: null,
    depth, node: process.versions.node, work_dir: work, manifest: null, steps: [], package: null, instance_dir: null,
    reproducibility: null, evidence_log: join(work, "evidence.jsonl"), started_at: new Date().toISOString(), finished_at: "",
  };
  const finish = (failure: string | null): BuildReport => {
    report.failure = failure;
    report.verdict = failure ? "FAIL" : "PASS";
    report.finished_at = new Date().toISOString();
    evidence.record("build-report", `${repo}@${report.resolved_commit ?? opts.rev}`, report.verdict, { repo, rev: opts.rev, depth }, {
      failure, resolved_commit: report.resolved_commit, package: report.package && { ...report.package, files: report.package.files.length },
      reproducibility: report.reproducibility, steps: report.steps.map((s) => ({ phase: s.phase, id: s.id, exit: s.exit_code, skipped: s.skipped })),
    });
    writeFileSync(join(work, "build-report.json"), JSON.stringify(report, null, 2) + "\n");
    log(`${report.verdict}${failure ? `: ${failure}` : ""}  report: ${join(work, "build-report.json")}`);
    return report;
  };
  const run = (phase: StepRecord["phase"], step: BuildStep, cwd: string, env: NodeJS.ProcessEnv, vars: Record<string, string>) => {
    if (step.max_depth !== undefined && depth >= step.max_depth) {
      const rec: StepRecord = { phase, id: step.id, argv: step.run, cwd, exit_code: null, signal: null, duration_ms: 0, stdout_sha256: sha256(""), stderr_sha256: sha256(""), output_tail: "", skipped: `depth ${depth} >= max_depth ${step.max_depth}` };
      report.steps.push(rec);
      evidence.record("build-step", `${phase}:${step.id}`, "INFO", { argv: step.run }, { skipped: rec.skipped });
      log(`${phase}:${step.id} skipped (${rec.skipped})`);
      return { ...rec, stdout: "" };
    }
    const argv = template(step.run, vars);
    log(`${phase}:${step.id} $ ${argv.join(" ")}`);
    const r = exec(phase, step.id, argv, cwd, env, step.timeout_s);
    const { stdout, ...rec } = r;
    report.steps.push(rec);
    evidence.record("build-step", `${phase}:${step.id}`, r.exit_code === 0 ? "PASS" : "FAIL", { argv, cwd }, { exit_code: r.exit_code, signal: r.signal, duration_ms: r.duration_ms, stdout_sha256: r.stdout_sha256, stderr_sha256: r.stderr_sha256 });
    log(`  exit ${r.exit_code} (${r.duration_ms} ms)`);
    return r;
  };

  // 1. Source at an exact revision
  const source = join(work, "source");
  mkdirSync(source);
  const gitEnv = isolatedEnv(work, {});
  for (const [id, argv] of [
    ["git-init", ["git", "init", "-q"]],
    ["git-fetch", ["git", "fetch", "-q", "--depth", "1", repo, opts.rev]],
    ["git-checkout", ["git", "-c", "advice.detachedHead=false", "checkout", "-q", "FETCH_HEAD"]],
  ] as const) {
    const r = run("source", { id, run: [...argv] }, source, gitEnv, {});
    if (r.exit_code !== 0) return finish(`${id} failed`);
  }
  report.resolved_commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, env: gitEnv, encoding: "utf8" }).stdout.trim() || null;
  log(`source: ${repo} @ ${report.resolved_commit}`);

  // 2. Manifest from the repo itself
  const mPath = join(source, MANIFEST_FILE);
  if (!existsSync(mPath)) return finish(`no ${MANIFEST_FILE} in repository`);
  let manifest: BuildManifest;
  try {
    manifest = validateManifest(JSON.parse(readFileSync(mPath, "utf8")));
  } catch (e) {
    return finish((e as Error).message);
  }
  report.manifest = manifest;
  if (manifest.engines?.node && !satisfies(process.versions.node, manifest.engines.node)) {
    return finish(`node ${process.versions.node} does not satisfy ${manifest.engines.node}`);
  }

  const vars = { repo, rev: report.resolved_commit ?? opts.rev, work, depth: String(depth) };
  const childEnv = (w: string) => isolatedEnv(w, { FE_SOURCE_COMMIT: vars.rev, FE_BUILD_DEPTH: String(depth + 1) });

  // 3. Build in the source tree
  let packStdout = "";
  for (const step of manifest.source_steps) {
    const r = run("source", step, source, childEnv(join(work, "source-env")), vars);
    if (r.skipped) continue;
    if (r.exit_code !== 0) return finish(`source step ${step.id} exited ${r.exit_code}`);
    if (step.id === manifest.package.tarball_from_step) packStdout = r.stdout;
  }

  // 4. Package
  let tarName: string;
  try {
    const parsed = JSON.parse(packStdout) as { filename: string }[];
    tarName = parsed[0].filename;
  } catch {
    return finish("package step did not print `npm pack --json` output");
  }
  const tarPath = join(source, tarName.replace(/^@/, "").replace("/", "-"));
  if (!existsSync(tarPath)) return finish(`package tarball ${tarPath} not found`);
  const tarBuf = readFileSync(tarPath);
  const files = readTgz(tarBuf);
  report.package = { file: tarPath, integrity: sriSha512(tarBuf), size: tarBuf.length, files: [...files.keys()].sort() };
  evidence.record("package", tarName, "PASS", { tarball: tarPath }, { integrity: report.package.integrity, size: tarBuf.length, files: report.package.files });
  log(`package: ${tarName} ${report.package.integrity.slice(0, 30)}… (${files.size} files)`);

  // 5. Second instance from the package only
  const instance = join(work, "instance");
  for (const [name, body] of files) {
    const dest = join(instance, name.replace(/^package\//, ""));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, body);
  }
  report.instance_dir = instance;
  for (const step of manifest.instance_steps) {
    const r = run("instance", step, instance, childEnv(join(work, "instance-env")), vars);
    if (r.skipped) continue;
    if (r.exit_code !== 0) return finish(`instance step ${step.id} exited ${r.exit_code}`);
  }

  // 6. Reproducibility: if the instance rebuilt the project, its package must be byte-identical
  const cmp = manifest.reproducibility?.compare_child_report;
  if (cmp) {
    const childPath = template([cmp], vars)[0];
    if (existsSync(childPath)) {
      const child = JSON.parse(readFileSync(childPath, "utf8")) as BuildReport;
      const identical = child.verdict === "PASS" && child.package?.integrity === report.package.integrity;
      report.reproducibility = { child_report: childPath, child_integrity: child.package?.integrity ?? null, identical };
      evidence.record("reproducibility", tarName, identical ? "PASS" : "FAIL", { parent: report.package.integrity }, report.reproducibility);
      log(`reproducibility: child ${child.verdict}, package ${identical ? "byte-identical" : "DIFFERS"}`);
      if (!identical) return finish("child rebuild did not reproduce an identical package");
    } else {
      const bounded = manifest.instance_steps.filter((s) => s.max_depth !== undefined);
      const rebuildRan = bounded.some((s) => depth < (s.max_depth as number));
      if (rebuildRan) return finish(`expected child report ${childPath} was not produced`);
    }
  }

  const chain = evidence.verifyChain();
  if (chain.length) return finish(`evidence chain broken: ${chain.join("; ")}`);
  return finish(null);
}
