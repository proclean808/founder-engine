# founder-engine: Claude Code briefing

PlatFormula.One founder-to-capital engine, branded **LiveVibe VentureLab.Studio**. This repo is built, previewed and published through Claude Code + GitHub + Vercel. Read this first; `README.md` has the full detail.

## Stages (all in this repo)

| Stage | Code | Live page | State |
|---|---|---|---|
| 1. Curation → vetted OSS stack → working MVP | `src/pipeline.ts`, `discovery`, `provenance`, `license`, `compat`, `repo-vetting`, `build-project` | `/` | Live; Verified by CI |
| 2. Pitch Studio: founder twin, co-CTO, co-CFO; investor lens; restricted-IP gate | `src/pitch.ts`, `src/access.ts`, `public/pitch.html` | `/pitch.html` | Live |
| 3. Venture Studio: accounts, venture record, deal flow, lessons memory | `src/studio.ts`, `src/v1.ts`, `src/auth.ts`, `src/db.ts`, `sql/*.sql`, `public/studio.html` | `/studio.html` | Built + tested; **production DB not connected yet** (`/api/v1/*` → 503) |
| Presenter Studio: three presenters, one speaker at a time, interruption, selectable model/voice/face, bake-off | `src/presenter.ts`, `src/bakeoff.ts`, `src/presenter-web.ts`, `web/` | `/presenter/` | Built + tested offline; vendor voices/faces need keys |
| Exploratory UI shells | `public/experience-lab.html` | `/experience-lab.html` | Live |

## Stack

- TypeScript on Node ≥ 20, compiled with `tsc` to `dist/`.
- Vercel serverless functions in `api/*.js`, thin wrappers over `src/web.ts` and `src/v1.ts`.
- Plain HTML/CSS/JS in `public/` for the original pages. The Presenter Studio (`web/`, served at `/presenter/`) is React 19 + Vite 8, approved by the founder 2026-11-15; react, react-dom, scheduler, vite and @vitejs/plugin-react were vetted with `scripts/vet-npm.mjs` (see `rosters/presenter-frontend.results.json`) and are exact-pinned devDependencies bundled at build. No Tailwind or Supabase SDK yet.
- PostgreSQL through `pg`. Any Postgres works (Vercel Marketplace / Neon, or Supabase used purely as a Postgres host). `DATABASE_URL` or `POSTGRES_URL`.
- Runtime dependencies: only `chrono-node` and `pg`, both exact pins.

## Commands

```bash
npm ci
npm test                                   # build + 40 tests (studio suite skips without a DB)
FE_TEST_DATABASE_URL=postgres://... npm test   # include the real-Postgres studio suite
npm run pipeline                           # Stage 1 end-to-end against live npm/GitHub
node dist/src/cli.js vet-repos <roster.txt>  # vet non-npm components (licence at pinned commit)
node dist/src/cli.js migrate               # apply sql/ migrations (needs DATABASE_URL)
node scripts/smoke-production.mjs          # production smoke (6 checks)
node dist/src/cli.js bakeoff               # presenter bake-off (governance checks for every face/voice)
npm run build:web                          # build the Presenter Studio into public/presenter/
```

Local Postgres for the studio suite: create a database owned by a role with `CREATEROLE`; tests use a throwaway schema per run.

## Ship flow (preview → production)

1. Branch from `main` and push. Vercel builds a **preview deployment** for the branch automatically.
2. Open a PR. GitHub Actions `acceptance` runs: unit tests on Node 20/22, Stage 1 pipeline, self-rebuild reproducibility, studio suite on Postgres 16.
3. Check the preview URL (Vercel bot comment, or `list_deployments` by branch).
4. Merge to `main` once CI is green. Vercel promotes to production at `founder-engine-five.vercel.app`.

Vercel: team `team_keR6ZIH8wIfNTrXQa9YQZMn0`, project `prj_xWalwfqkwbYElr4407TteoqZxmxk`. Other agents (ChatGPT/Codex, Atoms) also push to this repo. Always `git pull --rebase` first, and never force-push `main`. Atoms output goes to `atoms-benchmark`, never `main`.

## Rules: do not weaken these

- **No unvetted dependencies.** A new runtime dependency must pass provenance and licence vetting first: tarball sha512 = registry, release tag = `gitHead`, licence text = upstream at the pinned commit. Pin exact. MIT/BSD/ISC embed freely, Apache needs its NOTICE, GPL/AGPL only as separate processes.
- **Evidence over claims.** Statuses are `Proposed → Integrated → Tested → Verified/Blocked`. Only clean CI marks **Verified**. Never report anything as working without a receipt or a passing test.
- **Pitch grounding.** Every script line cites facts. No number may appear unless a cited fact contains it. LLM answers are validated and fall back to evidence. Uncovered questions escalate to the founder. The investor lens changes order only; `facts_hash` must stay identical across lenses.
- **Studio governance:**
  - Tenant isolation is FORCE RLS plus requests running as `fe_app`. The guard refuses any role that can bypass RLS.
  - Evidence tables are append-only, and the audit trail is hash-chained.
  - Investor invitations need the founder's explicit statement `I authorize inviting <name> to pitch v<n>`. Accredited access needs a third-party `verified_by`.
  - Lessons are advisory only.
- **No securities transactions.** No code that offers, negotiates, accepts, takes payment for or settles securities, and no transaction-based fees. Interest routes to the human founder. Securities counsel review of the operating model is an open item.
- **Never commit secrets.** No tokens, keys, `.env` files or database URLs.

## Open items

- Connect production Postgres in Vercel (Storage → Create Database → connect to this project), then run the acceptance flow on production.
- Review the `integration/interactive-venture-orchestrator` PR (investor challenge room; CI green, preview READY).
- Login throttling and account recovery; test for the expired-invitation path.
- Phone swarm (S25/S26 via Desktop Commander): `codex-termux` wrapper on the S25. Codex and Gemini CLIs need sign-in on the phone. See Baseline PR #19 for the device harness.
