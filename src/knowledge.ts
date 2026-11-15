// Venture knowledge base: versioned, attributed documents + keyword retrieval.
// This is retrieval-augmented context for whichever model the founder chooses.
// It does not fine-tune or otherwise change model weights.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ChatProvider } from "./provider.js";

export interface KnowledgeDoc {
  id: string;
  title: string;
  body: string;
  source: string; // where it came from (file, receipt, URL)
  evidence: string[]; // receipt hashes backing the doc
  version: number;
  updated_at: string;
}

const tokenize = (s: string) => s.toLowerCase().match(/[a-z0-9][a-z0-9\-]+/g) ?? [];

export class KnowledgeBase {
  private docs: KnowledgeDoc[];
  constructor(readonly path: string) {
    this.docs = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as KnowledgeDoc[]) : [];
  }

  list(): KnowledgeDoc[] {
    return [...this.docs];
  }

  upsert(doc: Omit<KnowledgeDoc, "version" | "updated_at">): KnowledgeDoc {
    const prev = this.docs.find((d) => d.id === doc.id);
    const next: KnowledgeDoc = { ...doc, version: (prev?.version ?? 0) + 1, updated_at: new Date().toISOString() };
    this.docs = [...this.docs.filter((d) => d.id !== doc.id), next];
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.docs, null, 2) + "\n");
    return next;
  }

  /** BM25-lite keyword scoring. */
  search(query: string, k = 3): { doc: KnowledgeDoc; score: number }[] {
    const q = new Set(tokenize(query));
    const N = this.docs.length || 1;
    const df = new Map<string, number>();
    for (const d of this.docs) for (const t of new Set(tokenize(`${d.title} ${d.body}`))) df.set(t, (df.get(t) ?? 0) + 1);
    return this.docs
      .map((doc) => {
        const toks = tokenize(`${doc.title} ${doc.body}`);
        let score = 0;
        for (const t of q) {
          const tf = toks.filter((x) => x === t).length;
          if (!tf) continue;
          const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
          score += idf * ((tf * 2.2) / (tf + 1.2));
        }
        return { doc, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  /** Retrieve, then ask the provider with cited context. */
  async ask(question: string, provider: ChatProvider): Promise<{ answer: string; sources: string[] }> {
    const hits = this.search(question);
    const context = hits.map((h, i) => `[${i + 1}] ${h.doc.title} (source: ${h.doc.source})\n${h.doc.body}`).join("\n\n");
    const answer = await provider.chat([
      {
        role: "system",
        content:
          "Answer only from the venture context below. Cite sources as [n]. If the context does not contain the answer, say so.\n\n" +
          (context || "(no context)"),
      },
      { role: "user", content: question },
    ]);
    return { answer, sources: hits.map((h) => h.doc.source) };
  }
}
