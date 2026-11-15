// Repository discovery via the public npm registry search API.
// Declared licenses here are claims only; verification happens in license.ts.

import type { Candidate, Capability } from "./types.js";

const REGISTRY = process.env.FE_NPM_REGISTRY ?? "https://registry.npmjs.org";

interface NpmSearchObject {
  package: {
    name: string;
    version: string;
    description?: string;
    license?: string;
    links?: { repository?: string };
  };
  score?: { final?: number };
  searchScore?: number;
}

export function normalizeRepoUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return url
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@github\.com\//, "https://github.com/")
    .replace(/\.git$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

export async function searchRegistry(capability: Capability, size = 10): Promise<Candidate[]> {
  const url = `${REGISTRY}/-/v1/search?text=${encodeURIComponent(capability.searchQuery)}&size=${size}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`npm search HTTP ${res.status}`);
  const body = (await res.json()) as { objects: NpmSearchObject[] };
  return body.objects.map((o) => ({
    name: o.package.name,
    version: o.package.version,
    declaredLicense: o.package.license ?? null,
    repositoryUrl: normalizeRepoUrl(o.package.links?.repository),
    description: o.package.description ?? "",
    score: o.score?.final ?? o.searchScore ?? 0,
    scoped: o.package.name.startsWith("@"),
  }));
}

export interface RankedCandidate extends Candidate {
  rank: number;
  notes: string[];
  eligible: boolean;
}

/**
 * Rank candidates:
 *  - prefer declared MIT (claim only; verified later)
 *  - collapse republished copies: several packages pointing at one upstream repo -> keep the
 *    unscoped original, mark the others as republishes
 *  - require a repository URL (no provenance otherwise)
 * Order of search results is preserved as the relevance signal.
 */
export function rankCandidates(candidates: Candidate[]): RankedCandidate[] {
  const byRepo = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (!c.repositoryUrl) continue;
    const list = byRepo.get(c.repositoryUrl) ?? [];
    list.push(c);
    byRepo.set(c.repositoryUrl, list);
  }
  const canonical = new Set<string>();
  for (const list of byRepo.values()) {
    const pick = list.find((c) => !c.scoped) ?? list[0];
    canonical.add(pick.name);
  }
  const unscopedNames = new Set(candidates.filter((c) => !c.scoped).map((c) => c.name));
  return candidates.map((c, i) => {
    const notes: string[] = [];
    let eligible = true;
    const bare = c.name.replace(/^@[^/]+\//, "");
    if (!c.repositoryUrl) {
      notes.push("no repository URL: provenance impossible");
      eligible = false;
    } else if (!canonical.has(c.name)) {
      notes.push(`republish of ${c.repositoryUrl}; upstream package preferred`);
      eligible = false;
    } else if (c.scoped && unscopedNames.has(bare)) {
      notes.push(`scoped copy of ${bare} from a different repository (likely fork); upstream package preferred`);
      eligible = false;
    }
    if (c.declaredLicense !== "MIT") {
      notes.push(`declared license ${c.declaredLicense ?? "none"} (MIT preferred)`);
      eligible = false;
    }
    return { ...c, rank: i + 1, notes, eligible };
  });
}
