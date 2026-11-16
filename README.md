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
npm test            # 22 offline tests
npm run pipeline    # full acceptance pipeline (needs network: npm registry + github.com)
open state/workspace.html

# the product itself
npm run extract -- fixtures/meeting-notes.txt --ref 2026-11-15
echo "- Dana: send invoice next Friday" | npm run extract --silent
```

Requires Node ≥ 20 and `git` on PATH. Works in Termux (`pkg install nodejs git`).

## Web backend (Vercel)

`public/index.html` together with three functions, all thin wrappers over `src/web.ts`:

| Endpoint | What it does |
|---|---|
| `POST /api/curate` `{intent}` | Runs the real pipeline for a founder's intent in an isolated temp dir. The intent is decomposed into building-block capabilities (dates, PDF, payments, search, CSV, email, charts, …), with one npm discovery per capability. The top candidates get provenance and license vetting. A candidate that has an adapter and an exact pin goes on to full integration, the acceptance test and the artifact. Returns the spec, registry, receipts and artifact. |
| `POST /api/extract` `{notes, ref?}` | The working tool: notes → action items |
| `POST /api/vet-repos` `{repos: ["owner/repo", …]}` | Repository-level vetting for non-npm components (Android apps, CLIs, services): pins the latest release tag (or default-branch HEAD), reads the licence at that commit, and classifies how the code can be reused |
| `GET /api/health` | Engine version, commit and pinned components |

On the hosted backend the runner is `service`, so results top out at **Tested**. Only CI marks **Verified**. Tag resolution uses git smart-HTTP (`info/refs`), so no `git` binary or GitHub API token is needed. Runs are stateless: the full result, including receipts, is returned and can be downloaded. Durable storage is not wired yet.

Curation candidates pass vetting when the tarball hash matches, the recorded source commit is confirmed upstream (by a release tag, or by fetching the license at that commit) and the license text matches upstream. Integrated dependencies are held to the stricter rule: the release tag must equal the registry `gitHead`.

## Pitch Studio (Milestone 2)

`/pitch.html` with `POST /api/pitch` and `POST /api/ask` (`src/pitch.ts`, `src/access.ts`):

- **Evidence pack → facts.** A curate run plus founder statements become numbered, sourced facts. Founder assumptions are always labelled as assumptions.
- **Three synthetic presenters:** founder digital twin, co-CTO and co-CFO, all with the same fact base.
- **Every script line cites facts.** A number may appear only if a cited fact contains it.
- **Q&A.** Each question is routed to the right presenter and answered from the evidence. Optional LLM answers are validated: citations must be real and numbers grounded, otherwise the answer falls back to the evidence text. Uncovered questions escalate to the founder's follow-up list.
- **Investor lens** (`lens: {investor, focus, basis}`) re-orders emphasis per investor. `facts_hash` is identical across lenses, which proves the facts didn't change.
- **Accreditation gate.** Founder lines starting `[restricted]` reach only viewers with a signed, expiring `accredited` token:
  ```bash
  FE_ACCESS_SECRET=<32+ chars> node dist/src/cli.js issue-access --investor "Jane <jane@acme.vc>" --level accredited --days 7 --verified-by "<provider> ref <id>"
  ```
  The engine does not verify accreditation; a regulated third party does. With no secret set on the deployment, restricted facts are never served.
- **Voice and avatars.** Browser speech synthesis and recognition, with interruption on typing or speaking. Avatars are abstract and labelled synthetic. A likeness or voice clone of the founder needs recorded consent and isn't built.

See `docs/milestone-2/LANDSCAPE.md` for the market and open-source landscape and the vetted roster, and `docs/atoms/milestone-2-pitch-studio.md` for the Atoms build description.

## Repository vetting (non-npm components)

```bash
node dist/src/cli.js vet-repos rosters/android-control.txt --out rosters/android-control.results.json
```

Each repo is handled the same way:
1. Resolve refs over git smart-HTTP.
2. Pin the latest semver release tag (peeled), or the default-branch HEAD if there are no tags.
3. Fetch the licence file at that commit. raw.githubusercontent.com is tried first, then github.com's redirect, which follows transferred or renamed repos.
4. Classify the licence from its text.

Each result records where the licence evidence came from: `full-text`, `declaration-in-license-file` or `readme-declaration`. It also records a reuse mode:

| Mode | Licences | Meaning |
|---|---|---|
| `embed` | MIT, BSD, ISC | Code may be copied into MIT modules |
| `embed-with-notice` | Apache-2.0 | Same, keeping the NOTICE |
| `separate-process-only` | GPL | Run as a separate app or process only |
| `network-copyleft` | AGPL | Run as a separate service, or publish changes |
| `file-copyleft` | MPL, LGPL, CC-BY-SA | Share-alike applies to the licensed files |

This is a mechanical reading of the licence text, not legal advice. See `rosters/android-control.md` for the two-phone control-plane roster.

## Building any repository, including this one

```bash
node dist/src/cli.js build-project --repo <git url|path> --rev <commit|tag|branch> --work <empty dir>
```

One interface covers a founder's repo and founder-engine itself. The target repo declares its own steps in `founder-engine.build.json`, versioned with its code. The engine:

1. Fetches the exact revision into an empty work dir and records the resolved commit.
2. Runs the manifest's `source_steps` with an isolated HOME, npm cache and env allowlist, so dependencies are re-resolved from the lockfile.
3. Packages the result and records the tarball's sha512 and file list.
4. Unpacks the tarball into a second empty dir (no git, no source) and runs `instance_steps` there.
5. Records every command, exit code, duration and output hash as hash-chained receipts, plus `build-report.json`.

**Self-reproduction.** This repo's manifest makes instance 1 run `build-project` on founder-engine again (`max_depth: 1` bounds the recursion). The rebuild is performed by the *packaged copy*, not the original checkout. Its package must be byte-identical to the parent's. CI job `self-rebuild` does this from GitHub at the pushed commit and asserts it.

Isolation limits:
- Isolation is directory, process and environment level. It is **not** a container or VM. The repo's declared commands run with the current user's permissions, so only build repositories you are authorized to execute.
- Credentials are never passed to build steps (GitHub, AWS and npm tokens are stripped). As a result, private repositories and private registries are not supported yet.
- A container runner (Docker/Podman, or sandboxd as a candidate) is the next isolation tier.

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
- Generic `build-project` (clone at rev → build → test → package → second instance → acceptance), with a credential-free env allowlist
- Self-reproduction: the packaged engine rebuilds itself, and the gen2 package is byte-identical to gen1

**Not tested against a live model**
The provider adapter has only been exercised against a local mock server. Set `FE_PROVIDER_BASE_URL`, `FE_PROVIDER_MODEL` and optionally `FE_PROVIDER_API_KEY` to use it. Keys are read from env only and are never written to disk.

**Not built (later milestones)**
- Conversational / voice onboarding (intake is file or stdin today)
- Adapters for any component other than `chrono-node` (others stop at Proposed)
- Non-GitHub upstream license fetch; non-npm ecosystems
- Signed receipts (Baseline rule 11: `SignedReceipt`). Receipts are hash-chained, not signed.
- Interactive web workspace, third-party integrations (Drive, Gmail, Supabase, Stripe)
- Container/VM isolation for build-project; private repos and registries
- Autonomous successor *design*. The engine can rebuild and verify itself. Proposing and promoting improvements needs separate evaluation and a human authorization gate, and is not built.
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
  build-project.ts  generic clone→build→package→instance builder (self-rebuild)
  cli.ts
test/unit.test.ts, test/build-project.test.ts
founder-engine.build.json   this repo's own build manifest
fixtures/           example founder idea + meeting notes
```

## License

MIT. See `LICENSE` and `THIRD_PARTY_NOTICES.md`.
