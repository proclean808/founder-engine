// License verification. A declared SPDX string or README badge is a claim, not evidence.
// Evidence = the license file shipped in the exact tarball, matched against the license file
// in the upstream repository at the pinned commit, plus a clause check of the text itself.
import { createHash } from "node:crypto";
import type { LicenseFinding } from "./types.js";

const LICENSE_FILE = /^package\/(LICEN[CS]E|COPYING)(\.(txt|md))?$/i;
const UPSTREAM_NAMES = ["LICENSE", "LICENSE.txt", "LICENSE.md", "LICENCE", "COPYING"];

// Licenses this MIT-licensed project may depend on without extra obligations beyond attribution.
export const PROJECT_COMPATIBLE = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD"]);

const MIT_CLAUSES = [
  /permission is hereby granted, free of charge, to any person obtaining a copy/i,
  /the above copyright notice and this permission notice shall be included in all\s+copies or substantial portions of the software/i,
  /the software is provided "as is", without warranty of any kind/i,
];

export function normalizeLicense(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n\n").trim();
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function hasMitClauses(text: string): boolean {
  const flat = text.replace(/\s+/g, " ");
  return MIT_CLAUSES.every((re) => re.test(flat));
}

export function copyrightLine(text: string): string | null {
  const m = text.match(/^\s*copyright\b.*$/im);
  return m ? m[0].trim() : null;
}

async function fetchUpstreamLicense(repo: string, commit: string): Promise<{ url: string; text: string } | null> {
  const gh = repo.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)$/);
  if (!gh) return null; // only GitHub supported in milestone 1
  for (const f of UPSTREAM_NAMES) {
    const url = `https://raw.githubusercontent.com/${gh[1]}/${commit}/${f}`;
    const res = await fetch(url);
    if (res.ok) return { url, text: await res.text() };
  }
  return null;
}

export async function verifyLicense(
  files: Map<string, Buffer>,
  repo: string | null,
  commit: string | null,
): Promise<LicenseFinding> {
  const problems: string[] = [];
  const pkgJson = files.get("package/package.json");
  const declared = pkgJson ? ((JSON.parse(pkgJson.toString("utf8")).license as string | undefined) ?? null) : null;
  if (!declared) problems.push("package.json in tarball declares no license");

  const licEntry = [...files.entries()].find(([n]) => LICENSE_FILE.test(n));
  const tarText = licEntry ? normalizeLicense(licEntry[1].toString("utf8")) : null;
  if (!tarText) problems.push("no license file shipped in tarball");

  let upstream: { url: string; text: string } | null = null;
  if (repo && commit) upstream = await fetchUpstreamLicense(repo, commit);
  else problems.push("no repository/commit: cannot compare against upstream");
  const upText = upstream ? normalizeLicense(upstream.text) : null;
  if (repo && commit && !upText) problems.push("no license file found upstream at pinned commit");

  const tarballMatchesUpstream = Boolean(tarText && upText && sha256(tarText) === sha256(upText));
  if (tarText && upText && !tarballMatchesUpstream) problems.push("tarball license differs from upstream license at commit");

  const mit = tarText ? hasMitClauses(tarText) : false;
  let spdx: string | null = null;
  if (mit) spdx = "MIT";
  if (declared === "MIT" && !mit) problems.push("declares MIT but license text lacks required MIT clauses");
  if (mit && declared && declared !== "MIT") problems.push(`text is MIT but package.json declares ${declared}`);

  const compatibleWithProject = Boolean(spdx && PROJECT_COMPATIBLE.has(spdx) && problems.length === 0);
  return {
    spdx,
    declaredInPackageJson: declared,
    tarballLicenseFile: licEntry ? licEntry[0] : null,
    tarballLicenseSha256: tarText ? sha256(tarText) : null,
    upstreamLicenseUrl: upstream?.url ?? null,
    upstreamLicenseSha256: upText ? sha256(upText) : null,
    tarballMatchesUpstream,
    mitClausesPresent: mit,
    copyrightLine: tarText ? copyrightLine(tarText) : null,
    licenseText: tarText,
    compatibleWithProject,
    problems,
  };
}
