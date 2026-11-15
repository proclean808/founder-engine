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

/** Parse git smart-HTTP ref advertisement (pkt-line) into ref -> sha. */
export function parseRefAdvertisement(body: string): Map<string, string> {
  const refs = new Map<string, string>();
  let i = 0;
  while (i + 4 <= body.length) {
    const len = parseInt(body.slice(i, i + 4), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      i += 4;
      continue;
    }
    const line = body.slice(i + 4, i + len).replace(/\n$/, "").split("\0")[0];
    i += len;
    const m = line.match(/^([0-9a-f]{40}) (\S+)$/);
    if (m) refs.set(m[2], m[1]);
  }
  return refs;
}

/** Resolve a release tag via the smart-HTTP endpoint (no git binary, no API token, no API rate limit). */
async function resolveTagCommitHttp(repoUrl: string, version: string): Promise<{ ref: string; commit: string } | null> {
  const res = await fetch(`${repoUrl}.git/info/refs?service=git-upload-pack`, { headers: { "user-agent": "git/2.45.0 founder-engine" } });
  if (res.status === 404 || res.status === 401 || res.status === 403) return null; // repo gone or private: no tag evidence
  if (!res.ok) throw new Error(`ref advertisement HTTP ${res.status}`);
  const refs = parseRefAdvertisement(await res.text());
  for (const tag of [`v${version}`, version]) {
    const ref = `refs/tags/${tag}`;
    const commit = refs.get(`${ref}^{}`) ?? refs.get(ref);
    if (commit) return { ref, commit };
  }
  return null;
}

/** Resolve a tag to its commit, dereferencing annotated tags. HTTPS first; git ls-remote as fallback. */
export async function resolveTagCommit(repoUrl: string, version: string): Promise<{ ref: string; commit: string } | null> {
  try {
    return await resolveTagCommitHttp(repoUrl, version);
  } catch {
    /* network-level failure: fall through to git if it exists on this host */
  }
  for (const tag of [`v${version}`, version]) {
    let stdout: string;
    try {
      ({ stdout } = await exec("git", ["ls-remote", repoUrl, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { timeout: 60_000 }));
    } catch {
      return null;
    }
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
