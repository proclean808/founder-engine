// Vet exact npm versions: tarball sha512 == registry SRI, gitHead == release tag commit,
// licence text in tarball == upstream licence at that commit. Writes a results file + receipts.
import { writeFileSync } from "node:fs";
import { verifyProvenance, fetchGithubFile } from "../dist/src/provenance.js";
import { verifyLicense, normalizeLicense, sha256 } from "../dist/src/license.js";
import { readTgz } from "../dist/src/tar.js";
import { EvidenceLog } from "../dist/src/evidence.js";

const [out, ...specs] = process.argv.slice(2);
if (!out || !specs.length) { console.error("usage: vet-npm.mjs <out.json> name@version ..."); process.exit(2); }
const log = new EvidenceLog(out.replace(/\.json$/, ".evidence.jsonl"));
const results = [];
for (const spec of specs) {
  const at = spec.lastIndexOf("@");
  const name = spec.slice(0, at), version = spec.slice(at + 1);
  try {
    const { provenance, tarball, meta } = await verifyProvenance(name, version);
    const files = readTgz(tarball);
    // Licence is compared at the published gitHead; if the package publishes none, at the release tag.
    const commit = provenance.gitHead ?? provenance.tagCommit;
    const lic = await verifyLicense(files, provenance.repository, commit);
    // Monorepos (vite) ship the package-directory licence, which can differ from the repo root one.
    const dir = typeof meta.repository === "object" ? meta.repository.directory : null;
    const slug = provenance.repository?.match(/github\.com\/([^/]+\/[^/]+)$/)?.[1];
    if (!lic.tarballMatchesUpstream && dir && slug && commit && lic.tarballLicenseFile) {
      const file = lic.tarballLicenseFile.replace(/^package\//, "");
      const hit = await fetchGithubFile(slug, commit, `${dir}/${file}`);
      if (hit && sha256(normalizeLicense(hit.text)) === lic.tarballLicenseSha256) {
        lic.tarballMatchesUpstream = true;
        lic.upstreamLicenseUrl = hit.url;
        lic.upstreamLicenseSha256 = lic.tarballLicenseSha256;
        lic.problems = lic.problems.filter((x) => !/differs from upstream/.test(x));
        lic.compatibleWithProject = lic.spdx === "MIT" && lic.problems.length === 0;
      }
    }
    const licOk = lic.tarballMatchesUpstream && lic.compatibleWithProject;
    // Strict: gitHead == tag. Partial: one of them is missing upstream (no gitHead published, or the
    // package is not tagged separately); tarball integrity + licence-at-commit still hold.
    const strict = provenance.tarballSha512Matches && provenance.gitHeadMatchesTag && licOk;
    const partial = !strict && provenance.tarballSha512Matches && licOk && Boolean(commit) && (!provenance.gitHead || !provenance.tagCommit);
    const status = strict ? "strict" : partial ? (provenance.gitHead ? "partial: package has no release tag; gitHead verified only" : "partial: package publishes no gitHead; release tag used") : "fail";
    const pass = strict || partial;
    const { licenseText, ...licSummary } = lic;
    const r = { name, version, pass, status, provenance, license: licSummary };
    results.push(r);
    log.record("vetting", `${name}@${version}`, pass ? "PASS" : "FAIL", { name, version }, r);
    console.log(`${status.toUpperCase().split(":")[0]} ${name}@${version} sha=${provenance.tarballSha512Matches} tag=${provenance.tagRef} gitHead=${provenance.gitHeadMatchesTag} lic=${lic.spdx} upstream=${lic.tarballMatchesUpstream} ${lic.problems.join("; ")}`);
  } catch (e) {
    results.push({ name, version, pass: false, error: String(e.message ?? e) });
    console.log(`FAIL ${name}@${version} ${e.message}`);
  }
}
writeFileSync(out, JSON.stringify({ vetted_at: new Date().toISOString(), results }, null, 2) + "\n");
process.exit(results.every((r) => r.pass) ? 0 : 1);
