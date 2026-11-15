// Offline tests of the generic build interface using a throwaway local git repository.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildProject, isolatedEnv, validateManifest, MANIFEST_FILE } from "../src/build-project.js";
import { EvidenceLog } from "../src/evidence.js";

function makeRepo(manifest: object, extra: Record<string, string> = {}): { dir: string; rev: string } {
  const dir = mkdtempSync(join(tmpdir(), "fe-repo-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "tiny-founder-app", version: "1.0.0", main: "index.js", files: ["index.js"] }));
  writeFileSync(join(dir, "index.js"), "module.exports = (a, b) => a + b;\n");
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest));
  for (const [f, body] of Object.entries(extra)) writeFileSync(join(dir, f), body);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qm", "init");
  return { dir, rev: git("rev-parse", "HEAD") };
}

const tinyManifest = {
  schema_version: "1.0.0",
  name: "tiny-founder-app",
  source_steps: [
    { id: "test", run: ["node", "-e", "if (require('./index.js')(2, 3) !== 5) process.exit(1)"] },
    { id: "package", run: ["npm", "pack", "--json"] },
  ],
  package: { tarball_from_step: "package" },
  instance_steps: [
    { id: "no-source-tree", run: ["node", "-e", "require('fs').existsSync('.git') && process.exit(1)"] },
    { id: "acceptance", run: ["node", "-e", "if (require('./index.js')(40, 2) !== 42) process.exit(1)"] },
  ],
};

test("build-project: founder repo is cloned at rev, built, packaged, and a second instance passes", () => {
  const { dir, rev } = makeRepo(tinyManifest);
  const work = join(mkdtempSync(join(tmpdir(), "fe-work-")), "w");
  const report = buildProject({ repo: dir, rev, workDir: work, depth: 0 });
  assert.equal(report.verdict, "PASS", report.failure ?? "");
  assert.equal(report.resolved_commit, rev);
  assert.match(report.package!.integrity, /^sha512-/);
  assert.ok(report.package!.files.includes("package/index.js"));
  assert.ok(existsSync(join(work, "instance", "index.js")));
  assert.ok(!existsSync(join(work, "instance", MANIFEST_FILE)), "instance contains only packaged files");
  assert.deepEqual(report.steps.filter((s) => s.phase === "instance").map((s) => [s.id, s.exit_code]), [["no-source-tree", 0], ["acceptance", 0]]);
  assert.deepEqual(new EvidenceLog(report.evidence_log).verifyChain(), []);
  assert.equal(JSON.parse(readFileSync(join(work, "build-report.json"), "utf8")).verdict, "PASS");
});

test("build-project: a failing instance step fails the build and is recorded", () => {
  const broken = { ...tinyManifest, instance_steps: [{ id: "acceptance", run: ["node", "-e", "process.exit(3)"] }] };
  const { dir, rev } = makeRepo(broken);
  const report = buildProject({ repo: dir, rev, workDir: join(mkdtempSync(join(tmpdir(), "fe-work-")), "w"), depth: 0 });
  assert.equal(report.verdict, "FAIL");
  assert.match(report.failure!, /instance step acceptance exited 3/);
});

test("build-project: repository without a manifest fails closed", () => {
  const { dir, rev } = makeRepo(tinyManifest);
  execFileSync("git", ["rm", "-q", MANIFEST_FILE], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qm", "rm"], { cwd: dir });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();
  const report = buildProject({ repo: dir, rev: head, workDir: join(mkdtempSync(join(tmpdir(), "fe-work-")), "w") });
  assert.equal(report.verdict, "FAIL");
  assert.match(report.failure!, /no founder-engine.build.json/);
});

test("build-project: bounded recursion step is skipped at max depth", () => {
  const m = { ...tinyManifest, instance_steps: [...tinyManifest.instance_steps, { id: "recurse", max_depth: 1, run: ["node", "-e", "process.exit(9)"] }] };
  const { dir, rev } = makeRepo(m);
  const report = buildProject({ repo: dir, rev, workDir: join(mkdtempSync(join(tmpdir(), "fe-work-")), "w"), depth: 1 });
  assert.equal(report.verdict, "PASS", report.failure ?? "");
  assert.match(report.steps.find((s) => s.id === "recurse")!.skipped!, /max_depth/);
});

test("build-project: refuses a non-empty work dir", () => {
  const { dir, rev } = makeRepo(tinyManifest);
  const work = mkdtempSync(join(tmpdir(), "fe-work-"));
  writeFileSync(join(work, "x"), "");
  assert.throws(() => buildProject({ repo: dir, rev, workDir: work }), /not empty/);
});

test("isolated env never carries credentials", () => {
  process.env.GITHUB_TOKEN = "ghp_should_not_leak";
  process.env.AWS_SECRET_ACCESS_KEY = "nope";
  process.env.NPM_TOKEN = "nope";
  const env = isolatedEnv(mkdtempSync(join(tmpdir(), "fe-env-")), {});
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.NPM_TOKEN, undefined);
  assert.ok(env.HOME && env.HOME.includes("fe-env-"));
});

test("manifest validation rejects shell strings and missing package step", () => {
  assert.throws(() => validateManifest({ ...tinyManifest, source_steps: [{ id: "x", run: "npm ci" }] }), /argv array/);
  assert.throws(() => validateManifest({ ...tinyManifest, package: { tarball_from_step: "nope" } }), /tarball_from_step/);
});
