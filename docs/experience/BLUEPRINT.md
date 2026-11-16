# LiveVibe VentureLab.Studio: experience blueprint (hybrid of the top 3 per stage)

Status: **proposal**. Nothing in this document is built yet. The engine underneath (evidence, provenance, grounding, governance) is built and stays as-is.

## Diagnosis of the current previews (2026-11-15)

| Screen | What it is today | What's wrong |
|---|---|---|
| `/` Curation | Textarea + 2 buttons, then a text dump | The engine's work (live search, hash checks, licence diffs, tests, receipts) is invisible. No conversation, no motion, no running app |
| `/pitch.html` | A 13-field setup form before anything happens | It's a wizard, not a pitch. No slides, no faces, no visuals |
| `/studio.html` | Login form + "database not configured" | Dead end. The board, history and lessons never render |

**Root cause:** form-first and engine-hidden. **Fix:** experience-first, where the evidence *is* the visual.

---

## Stage 1: Conversation → company (curation + build)

| Top 3 | Best-in-class strength we take |
|---|---|
| **Lovable** | Non-developer flow: conversational build, polished visual output, full-stack app (auth + DB) from a prompt |
| **Bolt.new** | The app **runs live in the browser** while it's being built. Instant, inspectable preview |
| **Replit Agent** | Built-in database, hosting and deploy. Long-running autonomous agent with a visible plan |
| (ref) Atoms | Visible multi-agent team: roles, hand-offs, progress |

**Hybrid feature set:**
1. **Voice-or-chat intake** with live spec cards that fill in as you talk (problem, user, constraints, capabilities), with follow-up questions asked in the conversation.
2. **Agent team board.** Each agent (researcher, architect, builder, verifier) has a lane showing what it's doing now, streamed live.
3. **Assembly theatre.** Each candidate component appears as a card. As each check runs, an animated pipeline shows it pass or fail (registry hash, release tag, licence diff, compatibility, test). Rejected forks visibly drop out, with the reason.
4. **Live running preview** of the assembled MVP in a sandbox pane, editable by chat.
5. **One-click deploy** to a preview URL, then promote.
6. **Evidence drawer:** every receipt, hash and test case, clickable.

**What none of the three have:** proof. Every component is provenance- and licence-verified, and every claim carries a receipt.

**Acceptance (pass/fail):**
- S1-1: from first word to the first spec card in ≤ 5 s; the spec updates live as the founder speaks.
- S1-2: each verification step for each candidate renders as a distinct animated state with its real hash or result, not a spinner.
- S1-3: the assembled MVP runs in a live preview pane without leaving the page.
- S1-4: deploy produces a working preview URL; the run is stored in the venture record.
- S1-5: works on a phone (360 px) and on desktop.

## Stage 2: Company → capital (the living pitch)

| Top 3 | Best-in-class strength we take |
|---|---|
| **Gamma** | Beautiful generated decks as interactive web cards: embeds, live charts, live data widgets, viewer analytics |
| **InteractPitch** | An avatar guides the investor through the deck asynchronously, with engagement analytics before the first call |
| **HeyGen** | Presenter realism: lifelike, lip-synced avatars |
| (ref) Decktopus | In-deck Q&A and CTA elements |

**Hybrid feature set:**
1. **Generated visual deck.** Cards built from the evidence pack: architecture diagram, component wall with licence badges, live test results, assumption charts with an "assumption" watermark, the ask. Each card is cinematic, with motion, imagery and real charts.
2. **Three 3D presenters** (founder twin, co-CTO, co-CFO), lip-synced and gesturing, handing off between each other. Built on vetted TalkingHead + three-vrm (MIT); VRM avatars, since Ready Player Me is gone.
3. **Live interruption.** Talk or type at any moment; the right presenter turns and answers on the relevant card, with citations as pop-overs.
4. **Investor lens:** per-investor ordering, with a visible "same facts" seal (the facts hash).
5. **Gated reveal.** Restricted cards unlock visually after verified accredited access.
6. **Engagement analytics,** deeper than page views: time per card, questions asked, which presenter, what escalated.
7. **Founder builds it in minutes:** run → auto-drafted deck → edit any card by chat → publish.

**What none of the three have:** answers that can't invent numbers, cryptographic proof that every investor saw the same facts, and accreditation-gated IP.

**Acceptance:**
- S2-1: a deck auto-generates from a run in ≤ 10 s with ≥ 8 visual cards; every card's claims cite facts.
- S2-2: presenters lip-sync to speech and hand off between each other; interruption stops speech within 300 ms.
- S2-3: a voice question is answered aloud by the correct presenter, with citation pop-overs; uncovered questions visibly escalate.
- S2-4: two investor lenses show different order with an identical facts seal.
- S2-5: restricted cards stay locked without an accredited invitation.
- S2-6: per-investor engagement report (cards, dwell, questions) is stored in the deal record.

## Stage 3: Capital → company (venture studio + deal flow)

| Top 3 | Best-in-class strength we take |
|---|---|
| **Visible** | Data room, investor pipeline and investor updates in one platform, connected to the same investor record |
| **Foundersuite** | Kanban fundraising CRM, investor database, outreach and email tracking |
| **DocSend** | Page-level deck engagement analytics (but no native CRM) |
| (ref) Metal / Signal | AI investor matching and relationship intelligence |

**Hybrid feature set:**
1. **Command center:** raise progress, pipeline value by stage, hot investors (engagement-ranked), open follow-ups, next actions.
2. **Kanban pipeline** with drag-and-drop. Human-only stages are locked to founder action, and every move is audited.
3. **Investor profile 360:** public-data thesis (SEC Form D via edgartools), lens settings, invitations, every session, Q&A transcripts, engagement heatmap, follow-ups.
4. **Discovery:** suggested investors from public filings and the founder's notes, with the basis shown. No paid database required.
5. **Data room** with restricted-tier gating and per-document analytics.
6. **Investor updates** generated from new receipts (milestones that are actually proven), sent only after founder approval.
7. **Lessons and audit timeline:** a visual hash-chained history, with tamper status shown.

**What none of the three have:** engagement means live interrogation transcripts, not page views. Updates are generated from verified evidence. And there's an immutable audit trail.

**Acceptance:**
- S3-1: the acceptance flow (create → curate → pitch → invite → Q&A → stage → fresh login → history) runs on **production**.
- S3-2: Kanban drag moves a stage; a refused move (backward or human-only) snaps back with the reason shown.
- S3-3: the investor 360 shows the session transcript and engagement from a real invite-link session.
- S3-4: an investor update draft cites only receipts newer than the last update, and cannot send without approval.
- S3-5: the audit timeline shows "intact"; the tamper test flips it to "broken at #n".

---

## Front-end direction (decision needed)

The engine and API (`src/`, `api/`) stay. The experience layer moves from hand-written HTML to:
- **React + Vite** single-page app, built into Vercel's static output next to the existing functions.
- **Tailwind CSS + shadcn/ui** (Radix primitives) for the design system.
- **Framer Motion** for motion.
- **three.js + TalkingHead + three-vrm** for presenters.
- **Recharts or D3** for charts.

Every new dependency goes through our provenance and licence vetting and gets an exact pin. This changes the current `CLAUDE.md` rule ("no React/Tailwind") and needs the founder's approval.

## Build order

1. Design system + app shell (dark, cinematic, mobile-first) + Stage 2 deck and presenters. This is the highest-impact demo.
2. Stage 1 assembly theatre + live preview.
3. Stage 3 command center + Kanban + investor 360, with production Postgres connected.

Each phase ships as a branch with a Vercel preview and passes its acceptance list before merging.

## Sources

- AI app builders: [nocode.mba 2026](https://nocode.mba/articles/best-ai-app-builders-2026), [arahi.ai 2026](https://arahi.ai/blog/best-ai-app-builders), [pokee.ai 2026](https://pokee.ai/blog/best-ai-app-builders-2026)
- Decks: [Gamma 2026 review](https://aiverdict.pages.dev/reviews/gamma-review-2026/), [Gamma features](https://codaone.pages.dev/tools/gamma), [Decktopus vs Gamma](https://www.decktopus.com/blog/decktopus-vs-gamma), plus `docs/milestone-2/LANDSCAPE.md`
- Fundraising: [Visible vs DocSend](https://visible.vc/blog/docsend-vs-visible-comparison/), [Foundersuite](https://www.papermark.com/blog/visible-vc-alternatives.md), [Papermark 2026 tools](https://www.papermark.com/blog/best-fundraising-tools-for-yc-startups.md)
