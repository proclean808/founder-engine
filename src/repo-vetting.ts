// Repository-level vetting for components that are not npm packages (Android apps, CLIs, servers).
//   1. ref advertisement over git smart-HTTP: default branch, HEAD commit, release tags (peeled)
//   2. pin: latest semver release tag if any, else default-branch HEAD
//   3. license: fetch the license file AT THE PINNED COMMIT and classify the text itself
//   4. reuse verdict: can the code be embedded in an MIT project, or only run as a separate process?
// This is not legal advice; it is a mechanical reading of the license text.
import { createHash } from "node:crypto";
import { parseRefAdvertisement, fetchGithubFile } from "./provenance.js";
import { normalizeLicense } from "./license.js";

export type ReuseMode = "embed" | "embed-with-notice" | "file-copyleft" | "separate-process-only" | "network-copyleft" | "unknown";

export interface RepoVetResult {
  repo: string; // https://github.com/owner/name (as requested)
  canonicalRepo: string | null; // where GitHub actually serves it (differs if transferred/renamed)
  reachable: boolean;
  defaultBranch: string | null;
  headCommit: string | null;
  latestTag: string | null;
  pinnedCommit: string | null;
  pinBasis: "release-tag" | "default-branch-head" | null;
  licenseFile: string | null;
  licenseUrl: string | null;
  licenseSha256: string | null;
  licenseBasis: "full-text" | "declaration-in-license-file" | "readme-declaration" | null;
  spdx: string | null;
  reuse: ReuseMode;
  reuseNote: string;
  status: "Proposed" | "Blocked";
  problems: string[];
}

const LICENSE_FILES = ["LICENSE", "LICENSE.txt", "LICENSE.md", "LICENCE", "COPYING", "COPYING.txt", "LICENSE-MIT", "LICENSE.MIT", "License.txt"];

// Ordered: more specific texts first.
const FINGERPRINTS: [string, RegExp[]][] = [
  ["AGPL-3.0", [/GNU AFFERO GENERAL PUBLIC LICENSE/i, /Version 3/i]],
  ["LGPL-3.0", [/GNU LESSER GENERAL PUBLIC LICENSE/i, /Version 3/i]],
  ["LGPL-2.1", [/GNU LESSER GENERAL PUBLIC LICENSE/i, /Version 2\.1/i]],
  ["GPL-3.0", [/GNU GENERAL PUBLIC LICENSE/i, /Version 3/i]],
  ["GPL-2.0", [/GNU GENERAL PUBLIC LICENSE/i, /Version 2/i]],
  ["MPL-2.0", [/Mozilla Public License,? (Version|v\.?) ?2\.0/i]],
  ["Apache-2.0", [/Apache License/i, /Version 2\.0/i]],
  ["MIT", [/Permission is hereby granted, free of charge/i, /THE SOFTWARE IS PROVIDED "AS IS"/i]],
  ["BSD-3-Clause", [/Redistribution and use in source and binary forms/i, /Neither the name/i]],
  ["BSD-2-Clause", [/Redistribution and use in source and binary forms/i]],
  ["ISC", [/Permission to use, copy, modify, and\/or distribute this software for any purpose/i]],
  ["Unlicense", [/This is free and unencumbered software released into the public domain/i]],
  ["CC-BY-SA-3.0", [/Creative Commons Attribution-ShareAlike 3\.0/i]],
  ["CC-BY-SA-4.0", [/Creative Commons Attribution-ShareAlike 4\.0/i]],
  ["CC0-1.0", [/CC0 1\.0 Universal/i]],
];

// Short declarations ("released under GPLv3") used when there is no full license text.
const DECLARATIONS: [string, RegExp][] = [
  ["AGPL-3.0", /released under (the )?\[?(GNU )?AGPL ?v?3/i],
  ["GPL-3.0", /released under (the )?\[?(GNU )?GPL ?v?3/i],
  ["GPL-2.0", /released under (the )?\[?(GNU )?GPL ?v?2/i],
  ["Apache-2.0", /released under (the )?\[?Apache (License )?2\.0/i],
  ["MIT", /released under (the )?\[?MIT/i],
];

export function classifyDeclaration(text: string): string | null {
  for (const [id, re] of DECLARATIONS) if (re.test(text)) return id;
  return null;
}

const REUSE: Record<string, [ReuseMode, string]> = {
  MIT: ["embed", "permissive; keep copyright + license text"],
  ISC: ["embed", "permissive; keep copyright + license text"],
  "BSD-2-Clause": ["embed", "permissive; keep copyright + license text"],
  "BSD-3-Clause": ["embed", "permissive; keep notice; no endorsement use of names"],
  Unlicense: ["embed", "public-domain dedication"],
  "Apache-2.0": ["embed-with-notice", "permissive; keep NOTICE, state changes; patent grant"],
  "MPL-2.0": ["file-copyleft", "modified MPL files stay MPL; can combine with MIT code"],
  "LGPL-2.1": ["file-copyleft", "library copyleft; dynamic linking / separate module recommended"],
  "LGPL-3.0": ["file-copyleft", "library copyleft; dynamic linking / separate module recommended"],
  "GPL-2.0": ["separate-process-only", "copyleft; run as a separate app/process; do not copy code into MIT modules"],
  "GPL-3.0": ["separate-process-only", "copyleft; run as a separate app/process; do not copy code into MIT modules"],
  "AGPL-3.0": ["network-copyleft", "copyleft incl. network use; run unmodified as a separate service or publish changes"],
  "CC-BY-SA-3.0": ["file-copyleft", "content licence (share-alike); not a software licence"],
  "CC-BY-SA-4.0": ["file-copyleft", "content licence (share-alike); not a software licence"],
  "CC0-1.0": ["embed", "public-domain dedication"],
};

export function classifyLicense(text: string): string | null {
  const flat = text.replace(/\s+/g, " ");
  for (const [id, res] of FINGERPRINTS) if (res.every((r) => r.test(flat))) return id;
  return null;
}

/** Parse refs + HEAD symref from a smart-HTTP advertisement. */
export function parseAdvertisement(body: string): { refs: Map<string, string>; headSymref: string | null } {
  const refs = parseRefAdvertisement(body);
  const m = body.match(/symref=HEAD:(refs\/heads\/[^\s\0]+)/);
  return { refs, headSymref: m ? m[1] : null };
}

function semverKey(tag: string): number[] | null {
  const m = tag.match(/^v?(\d+)\.(\d+)(?:\.(\d+))?$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

export function latestReleaseTag(refs: Map<string, string>): { tag: string; commit: string } | null {
  let best: { tag: string; commit: string; key: number[] } | null = null;
  for (const [ref, sha] of refs) {
    const m = ref.match(/^refs\/tags\/([^^]+)$/);
    if (!m) continue;
    const key = semverKey(m[1]);
    if (!key) continue;
    const commit = refs.get(`${ref}^{}`) ?? sha;
    if (!best || key[0] > best.key[0] || (key[0] === best.key[0] && (key[1] > best.key[1] || (key[1] === best.key[1] && key[2] > best.key[2])))) {
      best = { tag: m[1], commit, key };
    }
  }
  return best ? { tag: best.tag, commit: best.commit } : null;
}

export function normalizeGithubRepo(input: string): string {
  const m = input.trim().replace(/\.git$/, "").replace(/\/$/, "").match(/(?:github\.com\/)?([\w.-]+)\/([\w.-]+)$/);
  if (!m) throw new Error(`not a GitHub repository: ${input}`);
  return `https://github.com/${m[1]}/${m[2]}`;
}

export async function vetRepo(input: string): Promise<RepoVetResult> {
  const repo = normalizeGithubRepo(input);
  const out: RepoVetResult = {
    repo, canonicalRepo: null, reachable: false, defaultBranch: null, headCommit: null, latestTag: null, pinnedCommit: null, pinBasis: null,
    licenseFile: null, licenseUrl: null, licenseSha256: null, licenseBasis: null, spdx: null, reuse: "unknown", reuseNote: "", status: "Blocked", problems: [],
  };
  const res = await fetch(`${repo}.git/info/refs?service=git-upload-pack`, { headers: { "user-agent": "git/2.45.0 founder-engine" } });
  if (!res.ok) {
    out.problems.push(`repository not reachable (HTTP ${res.status}); missing, renamed or private`);
    return out;
  }
  out.reachable = true;
  const { refs, headSymref } = parseAdvertisement(await res.text());
  out.defaultBranch = headSymref?.replace("refs/heads/", "") ?? null;
  out.headCommit = refs.get("HEAD") ?? (headSymref ? refs.get(headSymref) ?? null : null);
  const tag = latestReleaseTag(refs);
  out.latestTag = tag?.tag ?? null;
  out.pinnedCommit = tag?.commit ?? out.headCommit;
  out.pinBasis = tag ? "release-tag" : out.headCommit ? "default-branch-head" : null;
  if (!out.pinnedCommit) {
    out.problems.push("no commit to pin (empty repository)");
    return out;
  }
  const slug = repo.replace("https://github.com/", "");
  for (const f of LICENSE_FILES) {
    const hit = await fetchGithubFile(slug, out.pinnedCommit, f);
    if (!hit) continue;
    const url = hit.url;
    const text = normalizeLicense(hit.text);
    out.licenseFile = f;
    out.licenseUrl = url;
    out.licenseSha256 = createHash("sha256").update(text).digest("hex");
    out.spdx = classifyLicense(text) ?? classifyDeclaration(text);
    if (out.spdx && !classifyLicense(text)) out.licenseBasis = "declaration-in-license-file";
    break;
  }
  if (!out.licenseFile) {
    // Fall back to a README declaration; recorded as weaker evidence.
    const readme = await fetchGithubFile(slug, out.pinnedCommit, "README.md");
    const declared = readme ? classifyDeclaration(readme.text) : null;
    if (readme && declared) {
      out.spdx = declared;
      out.licenseFile = "README.md";
      out.licenseUrl = readme.url;
      out.licenseBasis = "readme-declaration";
    } else out.problems.push("no license file at pinned commit: all rights reserved by default");
  } else if (!out.spdx) out.problems.push(`license file ${out.licenseFile} not recognised; manual review required`);
  const served = out.licenseUrl?.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\//);
  out.canonicalRepo = served ? `https://github.com/${served[1]}` : repo;
  if (out.spdx && !out.licenseBasis) out.licenseBasis = "full-text";
  if (out.spdx) [out.reuse, out.reuseNote] = REUSE[out.spdx] ?? ["unknown", "unclassified"];
  if (out.licenseBasis === "readme-declaration") out.reuseNote += "; licence declared only in README (no licence file): weaker evidence";
  if (out.licenseBasis === "declaration-in-license-file") out.reuseNote += "; licence file is a prose declaration, check per-directory exceptions";
  if (out.pinBasis === "default-branch-head") out.reuseNote += (out.reuseNote ? "; " : "") + "no release tags: pinned to default-branch HEAD";
  if (out.canonicalRepo && out.canonicalRepo.toLowerCase() !== repo.toLowerCase()) out.reuseNote = `repository moved to ${out.canonicalRepo}; update references; ${out.reuseNote}`;
  out.status = out.problems.length ? "Blocked" : "Proposed";
  return out;
}
