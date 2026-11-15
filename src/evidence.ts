// Hash-chained evidence receipts (append-only JSONL), modelled on Baseline's hydration receipts.
// A receipt records what was run, where, on what inputs, and what came out.
// It is not a signature: SignedReceipt (Baseline rule 11) is out of scope for milestone 1.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import type { Runner } from "./types.js";

export interface Receipt {
  schema_version: "1.0.0";
  receipt_id: string;
  kind: string;
  subject: string;
  result: "PASS" | "FAIL" | "INFO";
  created_at: string;
  environment: {
    runner: Runner;
    node: string;
    platform: string;
    repo_commit: string | null;
    ci_run_url: string | null;
  };
  inputs: unknown;
  outputs: unknown;
  prior_receipt_hash: string;
  receipt_hash: string;
}

export function detectRunner(env: NodeJS.ProcessEnv = process.env): Runner {
  return env.GITHUB_ACTIONS === "true" ? "ci" : "local";
}

function repoCommit(): string | null {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

function ciRunUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.GITHUB_ACTIONS !== "true") return null;
  return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
}

/** Canonical JSON: sorted keys, so hashes are stable. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(",")}}`;
}

export function hashReceipt(r: Omit<Receipt, "receipt_hash">): string {
  return createHash("sha256").update(canonical(r)).digest("hex");
}

export class EvidenceLog {
  constructor(readonly path: string) {}

  all(): Receipt[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Receipt);
  }

  lastHash(): string {
    const all = this.all();
    return all.length ? all[all.length - 1].receipt_hash : "genesis";
  }

  record(kind: string, subject: string, result: Receipt["result"], inputs: unknown, outputs: unknown): Receipt {
    const base: Omit<Receipt, "receipt_hash"> = {
      schema_version: "1.0.0",
      receipt_id: randomUUID(),
      kind,
      subject,
      result,
      created_at: new Date().toISOString(),
      environment: {
        runner: detectRunner(),
        node: process.versions.node,
        platform: `${process.platform}-${process.arch}`,
        repo_commit: repoCommit(),
        ci_run_url: ciRunUrl(),
      },
      inputs,
      outputs,
      prior_receipt_hash: this.lastHash(),
    };
    const receipt: Receipt = { ...base, receipt_hash: hashReceipt(base) };
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(receipt) + "\n");
    return receipt;
  }

  /** Recompute every hash and check the chain. Returns problems; empty means intact. */
  verifyChain(): string[] {
    const problems: string[] = [];
    let prior = "genesis";
    for (const [i, r] of this.all().entries()) {
      const { receipt_hash, ...rest } = r;
      if (r.prior_receipt_hash !== prior) problems.push(`receipt ${i} breaks chain`);
      if (hashReceipt(rest) !== receipt_hash) problems.push(`receipt ${i} hash mismatch (tampered)`);
      prior = receipt_hash;
    }
    return problems;
  }
}
