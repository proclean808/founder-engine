// Provenance: tie an npm version to its tarball hash and its upstream git commit.
//  1. registry metadata -> tarball URL, SRI integrity, gitHead
//  2. download tarball, recompute sha512, compare to integrity
//  3. git ls-remote the upstream tag (v<version> / <version>), dereference annotated tag,
//     compare commit to gitHead
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Provenance } from "./types.js";
import { normalizeRepoUrl } from "./discovery.js";

const exec = promisify(execFile);
const REGISTRY = process.env.FE_NPM_REGISTRY ?? "https://registry.npmjs.org";

export interface RegistryVersionMeta {
  name: string;
  version: string;
  license?: string;
  gitHead?: string;
  repository?: { url?: string } | string;
  author?: { name?: string } | string;
  engines?: Record<string, string>;
  dist: { tarball: string; integrity: string };
}

export async function fetchVersionMeta(name: string, version: string): Promise<RegistryVersionMeta> {
  const res = await fetch(`${REGISTRY}/${name.replace("/", "%2f")}/${version}`);
  if (!res.ok) throw new Error(`registry metadata HTTP ${res.status} for ${name}@${version}`);
  return (await res.json()) as RegistryVersionMeta;
}

export async function fetchTarball(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`tarball HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export function sriSha512(buf: Buffer): string {
  return `sha512-${createHash("sha512").update(buf).digest("base64")}`;
}

export function repoUrlOf(meta: RegistryVersionMeta): string | null {
  const r = typeof meta.repository === "string" ? meta.repository : meta.repository?.url;
  return normalizeRepoUrl(r);
}

/** Resolve a tag to its commit (dereferencing annotated tags) using git ls-remote. */
export async function resolveTagCommit(repoUrl: string, version: string): Promise<{ ref: string; commit: string } | null> {
  for (const tag of [`v${version}`, version]) {
    const { stdout } = await exec("git", ["ls-remote", repoUrl, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], {
      timeout: 60_000,
    });
    const lines = stdout.trim().split("\n").filter(Boolean).map((l) => l.split("\t"));
    if (lines.length === 0) continue;
    const peeled = lines.find(([, ref]) => ref.endsWith("^{}"));
    const [commit, ref] = peeled ?? lines[0];
    return { ref: ref.replace(/\^\{\}$/, ""), commit };
  }
  return null;
}

export async function verifyProvenance(
  name: string,
  version: string,
): Promise<{ provenance: Provenance; meta: RegistryVersionMeta; tarball: Buffer }> {
  const meta = await fetchVersionMeta(name, version);
  const tarball = await fetchTarball(meta.dist.tarball);
  const computed = sriSha512(tarball);
  const repository = repoUrlOf(meta);
  const tag = repository ? await resolveTagCommit(repository, version) : null;
  const gitHead = meta.gitHead ?? null;
  return {
    meta,
    tarball,
    provenance: {
      name,
      version,
      tarballUrl: meta.dist.tarball,
      integrity: meta.dist.integrity,
      tarballSha512Matches: computed === meta.dist.integrity,
      gitHead,
      repository,
      tagRef: tag?.ref ?? null,
      tagCommit: tag?.commit ?? null,
      gitHeadMatchesTag: Boolean(gitHead && tag && tag.commit === gitHead),
    },
  };
}
