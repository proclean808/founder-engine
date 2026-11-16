# Atoms build description: Milestone 2, Interactive Pitch Studio

Paste everything below the line into the existing Atoms project. A reference implementation already runs at https://founder-engine-five.vercel.app/pitch.html (source: `proclean808/founder-engine`, `src/pitch.ts`, `src/access.ts`, `public/pitch.html`). Atoms is judged by the same acceptance tests.

---

**Milestone 2: Interactive investor pitch with three grounded presenters.** Build on Milestone 1. Do not rebuild the founder-to-MVP pipeline. Write to branch `atoms-benchmark` of `proclean808/founder-engine` or to a separate repo, never `main`.

**Input.** A Milestone 1 run (venture spec, component registry, acceptance results, hash-chained receipts) plus founder statements:
- name
- one-liner
- the ask
- business/financial assumptions, one per line
- traction, one per line

Lines prefixed with `[restricted]` are IP.

**1. Evidence → facts.** Turn the run and the founder statements into a numbered fact base (F1…Fn). Each fact has:
- the presenter who owns it
- its source (spec, registry, receipt hash, or "founder input")

Founder assumptions are labelled as assumptions, never as results.

**2. Three presenters, one fact base.**
- **Founder digital twin:** problem, customer, vision, constraints, ask.
- **Co-CTO:** architecture, curated components (licence, pinned commit, status), test evidence, what is not built.
- **Co-CFO:** business model and assumptions exactly as stated. With no assumptions, it says so and presents no figures.

All three are clearly labelled synthetic. A likeness or voice of the real founder needs recorded consent, so it is not part of this milestone.

**3. Scripted presentation.** Generate a turn-taking script in which every line cites at least one fact. A number may appear in a line only if it appears in the cited facts. Play it with captions, citation chips, voice, and pause/next/previous controls. Typing or speaking interrupts the presenter.

**4. Live Q&A.**
- Route each question to the right presenter: money to the CFO, technology to the CTO, everything else to the founder.
- Answer only from the facts, with citations.
- If an LLM is used, validate its answer. Reject it if it cites facts that weren't retrieved, or contains a number absent from the cited facts. Fall back to the evidence text.
- When the evidence doesn't answer the question, escalate to the human founder and add it to a follow-up list. Never guess.

**5. Investor lens.** Per investor, re-order and emphasise sections (technical, market, financial) based on that investor's public focus. Record the basis for the focus. The fact set must be identical for every lens, shown and proven by a SHA-256 hash of the facts.

**6. Accreditation gate.**
- The engine does not verify accreditation. A regulated third party does (Rule 506(c) "reasonable steps").
- After that check, the founder issues a signed, expiring access token naming the investor and the verification reference.
- `[restricted]` facts are served only for accredited tokens.
- With no signing secret configured, restricted facts are never served (fail closed).

**7. Outputs.**
- A downloadable Q&A report: answered questions with citations, the founder follow-up list, and the evidence library.
- No securities transactions, solicitation, negotiation or commitments. Serious interest routes to the human founder.

**Components to evaluate before writing new code.** Licences were read from each repo's licence file at a pinned commit. See `docs/milestone-2/LANDSCAPE.md` for the full roster.
- Avatars: TalkingHead (MIT) and three-vrm (MIT). Ready Player Me shut down, so use VRM/GLB avatars from another source.
- Voice runtime: Pipecat (BSD-2) or LiveKit Agents (Apache-2.0; its turn-detection model has a separate licence).
- Speech: whisper.cpp (MIT) and Kokoro (Apache-2.0).
- Deck export: reveal.js, Slidev or Marp (MIT), or Presenton (Apache-2.0).
- KYC workflow: Ballerine (MIT at current commit).
- Investor research: edgartools (MIT) over public SEC data.
- Avoid embedding Papermark (AGPL plus commercial enterprise code). Open_Gamma has no licence file, so do not use it.

**Acceptance tests.** Both builds must pass all of these. No credit for screenshots or agent claims.
1. Every script line has at least one citation, and no line contains a number that is absent from the facts.
2. With no founder assumptions, the CFO presents no financial figures and says so.
3. "What is your pricing?" is answered by the CFO from the stated assumption. "What is the total addressable market?" (not in the evidence) escalates to the founder.
4. An LLM answer that invents a number (e.g. "5,000 customers") is rejected and replaced by the evidence text.
5. Two different investor lenses produce different section orders and an identical facts hash.
6. A `[restricted]` assumption is absent for public viewers, present for a valid accredited token, and absent for forged, expired or wrong-secret tokens, and whenever no secret is configured.
7. The live deployment serves the studio. `POST /api/pitch` and `POST /api/ask` work end to end from a real Milestone 1 run.

Report every capability as Implemented, Simulated or Not built.
