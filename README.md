# founder-engine

PlatFormula.One founder-to-MVP engine: curated open-source components, verified builds and evidence receipts.

Milestone 1 is one vertical slice, run end to end against live sources:

```
Founder input → structured specification → repository discovery → license verification
  → pinned integration → executable test → evidence receipt → usable artifact
```

Example venture: a founder who can't code wants a tool that turns meeting notes into action items with owners and due dates. The pipeline identifies the capability (natural-language date parsing), discovers candidates on npm, verifies `chrono-node` (MIT, wanasit/chrono), integrates it through one adapter, runs a calendar-derived acceptance test, records hash-chained receipts and produces the working tool.

## Quick start

```bash
npm ci              # installs exactly the lockfile pins
npm test            # 15 offline unit tests
npm run pipeline    # full acceptance pipeline (needs network: npm registry + github.com)
open state/workspace.html

# the product itself
npm run extract -- fixtures/meeting-notes.txt --ref 2026-11-15
echo "- Dana: send invoice next Friday" | npm run extract --silent
```

Requires Node ≥ 20 and `git` on PATH. Works in Termux (`pkg install nodejs git`).

## Component status

| Status | Meaning |
|---|---|
| Proposed | Discovered and eligible on *declared* metadata only. Nothing verified. |
| Integrated | Exact pin committed (authorization), tarball hash, upstream tag/commit, license and compatibility checks all passed. |
| Tested | Executable acceptance test passed on a local runner. |
| Verified | Acceptance test passed on an independent clean CI runner (`.github/workflows/acceptance.yml`). |
| Blocked | A check failed. The reason is recorded in the registry and the receipt. |

A component cannot skip a stage. Local runs top out at **Tested**. Only CI can mark **Verified**.

## What each check actually does

- **Discovery** (`src/discovery.ts`): npm registry search. Ranks by relevance, collapses republished copies of one upstream repository, and flags scoped copies from other repositories as likely forks. Declared licenses are treated as claims.
- **Authorization** (`src/pipeline.ts`): a dependency enters only through a committed exact pin in `package.json`. If the pin is absent, the component stays Proposed with "awaiting authorization".
- **Provenance** (`src/provenance.ts`): downloads the exact tarball, recomputes sha512 and compares it to the registry's SRI integrity. Resolves the upstream release tag with `git ls-remote` (dereferencing annotated tags) and requires it to equal the registry `gitHead`.
- **License** (`src/license.ts`): reads the license file *inside the tarball*, fetches the license file from the upstream repo *at the pinned commit*, requires byte-equal normalized text, and checks the MIT clauses in the text itself. A badge or SPDX string alone never passes.
- **Compatibility** (`src/compat.ts`): engines range against the running Node version, installed version against the pin, lockfile integrity against the registry, and an actual `import()`.
- **Acceptance** (`src/acceptance.ts`): seven cases with expected dates derived from the calendar (reference Sunday 2026-11-15 UTC), not from the component's output.
- **Evidence** (`src/evidence.ts`): append-only JSONL receipts, SHA-256 hash-chained over canonical JSON. Each records the runner, Node version, repo commit and CI run URL. Check one with `node dist/src/cli.js verify-evidence state/evidence/local.jsonl`.

`THIRD_PARTY_NOTICES.md` is generated from the verified license text.

## Implemented, simulated, not built

**Implemented and tested**
- Founder intake → `VentureSpec` (deterministic rules; optional LLM extraction, which falls back to rules if the provider output is invalid)
- Provenance-aware component registry with search and status history
- Live discovery, provenance, license and compatibility verification
- One genuine integration (`chrono-node`) with an executable acceptance test
- Hash-chained evidence receipts
- Venture knowledge base (versioned, source-attributed docs, keyword retrieval)
- OpenAI-compatible provider adapter (OpenAI, OpenRouter, vLLM, llama.cpp, Ollama `/v1`), tested against a local HTTP server
- The product: notes → action items (CLI)
- Static founder workspace rendered from real pipeline state
- Clean-runner CI verification on Node 20 and 22, with evidence uploaded as an artifact

**Not tested against a live model**
The provider adapter has only been exercised against a local mock server. Set `FE_PROVIDER_BASE_URL`, `FE_PROVIDER_MODEL` and optionally `FE_PROVIDER_API_KEY` to use it. Keys are read from env only and are never written to disk.

**Not built (later milestones)**
- Conversational / voice onboarding (intake is file or stdin today)
- Adapters for any component other than `chrono-node` (others stop at Proposed)
- Non-GitHub upstream license fetch; non-npm ecosystems
- Signed receipts (Baseline rule 11: `SignedReceipt`). Receipts are hash-chained, not signed.
- Interactive web workspace, third-party integrations (Drive, Gmail, Supabase, Stripe)
- Fine-tuning or other post-training. The knowledge base is retrieval only and does not change model weights.
- Avatar studio and the investor experience

## Boundaries

- **Baseline** (`proclean808/Baseline`) is the governance and evidence reference. Receipt structure follows its hydration receipts (canonical hashes, prior-hash chain). No Baseline code is vendored here.
- **KORA** owns orchestration, authorization, provenance policy, model routing and persistent project state. In this repo the matching seams are `ChatProvider` (routing), the exact-pin authorization gate, `EvidenceLog` and the `state/` stores. These are deliberately small so KORA can replace them.
- **Atoms benchmark.** Atoms output should go to a separate repository or an `atoms-benchmark` branch, never `main`. Both builds are judged by the same acceptance chain.

## Layout

```
src/
  intake.ts         founder input -> VentureSpec
  discovery.ts      npm search + ranking
  provenance.ts     tarball hash, gitHead <-> release tag
  license.ts        tarball license vs upstream at commit, MIT clauses
  compat.ts         engines, pin, lockfile, import
  adapters/chrono.ts the only file importing the component
  acceptance.ts     calendar-derived test cases
  evidence.ts       hash-chained receipts
  registry.ts       component registry + statuses
  knowledge.ts      venture knowledge base + retrieval
  provider.ts       OpenAI-compatible adapter
  product/          the founder's tool
  workspace.ts      static workspace page
  pipeline.ts       orchestrates the acceptance chain
  cli.ts
test/unit.test.ts
fixtures/           example founder idea + meeting notes
```

## License

MIT. See `LICENSE` and `THIRD_PARTY_NOTICES.md`.
