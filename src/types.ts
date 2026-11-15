// Shared types for the founder-to-MVP pipeline.

export type ComponentStatus = "Proposed" | "Integrated" | "Tested" | "Verified" | "Blocked";

// local: developer machine; ci: independent clean runner (only path to Verified);
// service: hosted web backend (founder requests; never counts as independent verification)
export type Runner = "local" | "ci" | "service";

export interface Capability {
  id: string;
  description: string;
  searchQuery: string;
}

export interface VentureSpec {
  schema_version: "1.0.0";
  venture_name: string;
  founder_statement: string;
  problem: string;
  target_user: string | null;
  stage: "idea" | "prototype" | "operating" | "unknown";
  capabilities: Capability[];
  constraints: string[];
  immediate_objective: string;
  open_questions: string[];
  extraction_method: "deterministic-rules" | "llm-provider";
}

export interface Candidate {
  name: string;
  version: string;
  declaredLicense: string | null;
  repositoryUrl: string | null;
  description: string;
  score: number;
  scoped: boolean;
}

export interface Provenance {
  name: string;
  version: string;
  tarballUrl: string;
  integrity: string;
  tarballSha512Matches: boolean;
  gitHead: string | null;
  repository: string | null;
  tagRef: string | null;
  tagCommit: string | null;
  gitHeadMatchesTag: boolean;
}

export interface LicenseFinding {
  spdx: string | null;
  declaredInPackageJson: string | null;
  tarballLicenseFile: string | null;
  tarballLicenseSha256: string | null;
  upstreamLicenseUrl: string | null;
  upstreamLicenseSha256: string | null;
  tarballMatchesUpstream: boolean;
  mitClausesPresent: boolean;
  copyrightLine: string | null;
  licenseText: string | null;
  compatibleWithProject: boolean;
  problems: string[];
}

export interface CompatFinding {
  nodeVersion: string;
  enginesRange: string | null;
  enginesSatisfied: boolean;
  installedVersion: string | null;
  installedMatchesPin: boolean;
  lockfileIntegrity: string | null;
  lockfileMatchesRegistry: boolean;
  importable: boolean;
  problems: string[];
}

export interface AcceptanceCase {
  id: string;
  input: string;
  referenceDate: string;
  expectedDate: string | null;
}

export interface AcceptanceResult {
  caseId: string;
  input: string;
  expected: string | null;
  actual: string | null;
  pass: boolean;
}

export interface RegistryEntry {
  name: string;
  version: string;
  capability: string;
  repository: string | null;
  upstreamAuthor: string | null;
  license: string | null;
  pinnedCommit: string | null;
  integrity: string | null;
  status: ComponentStatus;
  statusReason: string;
  evidence: string[]; // receipt hashes
  updated_at: string;
}
