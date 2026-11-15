// Component registry with explicit operational status.
//   Proposed   - discovered, eligible on declared metadata only
//   Integrated - pinned + adapter exists + provenance/license/compat checks pass
//   Tested     - executable acceptance test passed on a local runner
//   Verified   - acceptance test passed on an independent clean CI runner
//   Blocked    - a check failed; reason recorded
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ComponentStatus, RegistryEntry } from "./types.js";

export class ComponentRegistry {
  private entries: RegistryEntry[];
  constructor(readonly path: string) {
    this.entries = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as RegistryEntry[]) : [];
  }

  list(): RegistryEntry[] {
    return [...this.entries];
  }

  get(name: string): RegistryEntry | undefined {
    return this.entries.find((e) => e.name === name);
  }

  search(q: string): RegistryEntry[] {
    const s = q.toLowerCase();
    return this.entries.filter((e) => `${e.name} ${e.capability} ${e.license} ${e.status}`.toLowerCase().includes(s));
  }

  upsert(e: Omit<RegistryEntry, "updated_at">): RegistryEntry {
    const next = { ...e, updated_at: new Date().toISOString() };
    this.entries = [...this.entries.filter((x) => x.name !== e.name), next].sort((a, b) => a.name.localeCompare(b.name));
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.entries, null, 2) + "\n");
    return next;
  }

  setStatus(name: string, status: ComponentStatus, reason: string, receiptHash?: string): RegistryEntry {
    const e = this.get(name);
    if (!e) throw new Error(`unknown component ${name}`);
    return this.upsert({ ...e, status, statusReason: reason, evidence: receiptHash ? [...e.evidence, receiptHash] : e.evidence });
  }
}
