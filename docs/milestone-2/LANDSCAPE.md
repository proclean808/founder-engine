# Milestone 2 landscape: AI-native pitch decks, avatar presenters, venture studios

Generated 2026-11-15. The commercial landscape comes from web research (sources at the end). The open-source roster was vetted by `founder-engine vet-repos rosters/pitch-studio.txt`: each licence was read from the file at the pinned commit, not from a badge or article. This is a mechanical licence reading, not legal advice.

## What exists today, and the gap

| Category | Examples | What it does well | What it lacks for PlatFormula.One |
|---|---|---|---|
| AI deck generators | Gamma, Canva, Upmetrics, Beautiful.ai, Slidebean, Alai, ChatSlide | Fast slides from a prompt or document. Upmetrics ties the deck to a business plan and financial model | Static narrative. No evidence ledger. Claims aren't tied to proof |
| Avatar video | HeyGen investor-pitch videos | Polished avatar narration from a script | Pre-rendered video. No live Q&A, no grounding |
| Interactive avatar decks | InteractPitch | Founder avatar guides investors through the deck. Engagement analytics before the first call | One deck for everyone. No per-investor lens. No accreditation gate. No proof chain |
| Data rooms | Papermark (AGPL), DocSend | Page-level read analytics, NDA gating, permissions | Documents, not a conversation |
| Investor intelligence | Metal, Lessie, Fund Momentum (MCP) | Thesis, stage and portfolio matching | Separate from the pitch itself |
| Accreditation | North Capital (TransactAPI / Opera IQ), VerifyInvestor, DealMaker | Regulated Rule 506(c) "reasonable steps" verification | Commercial services. The pitch must call them, not replace them |
| AI-native venture studios | Alloy Partners' One Health Studio (1,000+ agents, nine companies), IAIG ($6M pre-seed led by Aleph), Forum Ventures AI studio fund, C10 Labs, TFSF | Systematic multi-venture building with agent swarms | Closed internal machinery. Founders don't get the engine |

**The gap PlatFormula.One fills:** one pipeline from verified build evidence, to grounded multi-presenter pitch, to per-investor emphasis with provably identical facts, to accreditation-gated IP, to human follow-up. Every product above covers one slice. None of them carry proof from the build through to the investor's question.

## Slice map (what we take from where)

| Slice | Implemented in founder-engine today | Open-source candidate to integrate next |
|---|---|---|
| Pitch from evidence, claims cite facts | `src/pitch.ts` (facts, script, citations, number guard) | — (ours; nothing above does this) |
| Three presenters: founder twin, co-CTO, co-CFO | `src/pitch.ts` personas + routing | — |
| Live Q&A, interruption, voice | `public/pitch.html` (browser speech) | Pipecat (BSD-2) or LiveKit Agents (Apache-2.0) for low-latency server voice; whisper.cpp + Kokoro self-hosted; sherpa-onnx on the phones |
| Avatar faces | Abstract SVG presenters (labelled synthetic) | TalkingHead (MIT) + three-vrm (MIT) with VRoid/VRM avatars. Ready Player Me is gone |
| Founder digital twin (own face/voice) | Not built; needs recorded consent | LivePortrait (code MIT) / MuseTalk (Apache-2.0). Check model-weight licences separately from code |
| Per-investor emphasis, facts unchanged | `InvestorLens` + `facts_hash` invariant (tests prove it) | edgartools (MIT) over public SEC EDGAR data for fund filings. Commercial thesis APIs optional |
| Accreditation gate for IP | `src/access.ts`: signed, expiring tokens after a third-party check; `[restricted]` facts; fails closed | Ballerine (now MIT) for KYC workflow. Accreditation itself via a regulated provider |
| Deck export / rendering | — | reveal.js / Slidev / Marp (MIT), or Presenton's API (Apache-2.0) for PPTX/PDF |
| Engagement analytics | Q&A report export | Papermark only as a separate service (AGPL + commercial `ee`). Or build on our receipts |
| Studio orchestration | founder-engine pipeline + Baseline governance | MetaGPT (MIT): the open core Atoms is built on |

## Vetted open-source roster

| Role | Repo | Licence (from file) | Reuse | Pin | Status | Notes |
|---|---|---|---|---|---|---|
| Deck generation | [presenton/presenton](https://github.com/presenton/presenton) | **Apache-2.0** | embed-with-notice | 0.5.10 `c1d2985e48` | Proposed | permissive; keep NOTICE, state changes; patent grant |
| Deck generation | [allweonedev/presentation-ai](https://github.com/allweonedev/presentation-ai) | **MIT** | embed | main `43fe74abd5` | Proposed | permissive; keep copyright + license text; no release tags: pinned to default-branch HEAD |
| Deck generation | [h9-tec/Open_Gamma](https://github.com/h9-tec/Open_Gamma) | **—** | unknown | main `a3abb506f9` | Blocked | no license file at pinned commit: all rights reserved by default |
| Deck rendering | [hakimel/reveal.js](https://github.com/hakimel/reveal.js) | **MIT** | embed | 6.0.2 `75dff6f515` | Proposed | permissive; keep copyright + license text |
| Deck rendering | [slidevjs/slidev](https://github.com/slidevjs/slidev) | **MIT** | embed | v53.1.0 `b547b48fe8` | Proposed | permissive; keep copyright + license text |
| Deck rendering | [marp-team/marp-core](https://github.com/marp-team/marp-core) | **MIT** | embed | v5.0.2 `01ef3a4ef0` | Proposed | permissive; keep copyright + license text |
| Avatar (3D, lip-sync) | [met4citizen/TalkingHead](https://github.com/met4citizen/TalkingHead) | **MIT** | embed | v1.8.2 `46b32ee539` | Proposed | permissive; keep copyright + license text |
| Avatar (3D, lip-sync) | [interviewflowai/talking-avatar](https://github.com/interviewflowai/talking-avatar) | **MIT** | embed | master `d3e4dcf660` | Proposed | permissive; keep copyright + license text; no release tags: pinned to default-branch HEAD |
| Avatar format (VRM) | [pixiv/three-vrm](https://github.com/pixiv/three-vrm) | **MIT** | embed | v3.5.5 `ff42fae4fc` | Proposed | permissive; keep copyright + license text |
| Photoreal twin (image-driven) | [KwaiVGI/LivePortrait](https://github.com/KwaiVGI/LivePortrait) | **MIT** | embed | main `9b294b3d05` | Proposed | permissive; keep copyright + license text; no release tags: pinned to default-branch HEAD |
| Photoreal twin (lip-sync) | [TMElyralab/MuseTalk](https://github.com/TMElyralab/MuseTalk) | **Apache-2.0** | embed-with-notice | main `0a89dec45a` | Proposed | permissive; keep NOTICE, state changes; patent grant; no release tags: pinned to default-branch HEAD |
| Conversation runtime | [pipecat-ai/pipecat](https://github.com/pipecat-ai/pipecat) | **BSD-2-Clause** | embed | v1.16.0 `7cf75afc37` | Proposed | permissive; keep copyright + license text |
| Conversation runtime | [livekit/agents](https://github.com/livekit/agents) | **Apache-2.0** | embed-with-notice | main `c927b7a0f8` | Proposed | permissive; keep NOTICE, state changes; patent grant; no release tags: pinned to default-branch HEAD |
| TTS | [hexgrad/kokoro](https://github.com/hexgrad/kokoro) | **Apache-2.0** | embed-with-notice | main `dfb907a02b` | Proposed | permissive; keep NOTICE, state changes; patent grant; no release tags: pinned to default-branch HEAD |
| STT | [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp) | **MIT** | embed | v1.9.5 `d1be6fde11` | Proposed | permissive; keep copyright + license text |
| On-device STT/TTS (Android) | [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | **Apache-2.0** | embed-with-notice | v2.0.1 `af2d8d81db` | Proposed | permissive; keep NOTICE, state changes; patent grant |
| KYC / identity workflow | [ballerine-io/ballerine](https://github.com/ballerine-io/ballerine) | **MIT** | embed | dev `8659a4be37` | Proposed | permissive; keep copyright + license text; no release tags: pinned to default-branch HEAD |
| Data room + view analytics | [mfts/papermark](https://github.com/mfts/papermark) | **AGPL-3.0** | network-copyleft | v0.22.0 `01c7812941` | Proposed | copyleft incl. network use; run unmodified as a separate service or publish changes |
| Investor research (SEC data) | [dgunning/edgartools](https://github.com/dgunning/edgartools) | **MIT** | embed | v6.2.0 `574c2bd15f` | Proposed | permissive; keep copyright + license text |
| Multi-agent studio core | [FoundationAgents/MetaGPT](https://github.com/FoundationAgents/MetaGPT) | **MIT** | embed | v0.8.2 `df9bc1858f` | Proposed | permissive; keep copyright + license text |

What vetting changed versus the published claims:
- **Open_Gamma:** the project advertises a licence badge, but there is **no licence file** at the pinned commit, so it is all rights reserved. Blocked.
- **Ballerine:** reported as Apache-2.0 in 2023. The file at the current commit reads **MIT**.
- **Papermark:** AGPL-3.0, with enterprise directories under a separate commercial licence. Separate service only.
- **LiveKit Agents:** the framework is Apache-2.0, but its turn-detection models ship under a separate model licence that only allows use with the LiveKit Agents framework.
- **Ready Player Me** shut down its public platform on January 31, 2026, after Netflix acquired it. TalkingHead must use VRM/GLB avatars from another source.

## Sources
- AI-native studios: [Alloy Partners](https://www.alloypartners.com/articles/agentic-venture-studio-building-nine-companies-with-1000-ai-agents), [IAIG](https://theaiinsider.tech/2026/08/18/ai-venture-studio-iaig-raises-6m-pre-seed-round-to-build-ai-native-software-companies/), [Forum Ventures](https://www.forumvc.com/thought-pieces/what-an-ai-native-b2b-company-actually-means), [C10 Labs](https://www.c10labs.com/), [SSRN framework](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6545918)
- Decks: [Unite.AI roundup](https://www.unite.ai/?p=336518), [Upmetrics](https://upmetrics.co/blog/best-ai-pitch-deck-generators), [InteractPitch](https://www.producthunt.com/products/interactpitch-2), [HeyGen](https://www.heygen.com/video/investor-pitch-generator)
- Open source: [Presenton](https://github.com/presenton/presenton), [ALLWEONE](https://github.com/allweonedev/presentation-ai), [TalkingHead](https://github.com/met4citizen/talkinghead), [talking-avatar](https://github.com/interviewflowai/talking-avatar), [Pipecat vs LiveKit](https://www.cekura.ai/blogs/pipecat-vs-livekit-the-real-difference), [LiveKit model licence](https://micdrop.dev/blog/open-source-voice-agent-frameworks)
- Investors and compliance: [SEC on accredited investors](https://www.sec.gov/files/accred-invest-assess-reg-d.pdf), [North Capital](https://northcapital.com/platform-technology/), [VerifyInvestor](https://verifyinvestor.com/how-to-verify-an-investor), [Form D data](https://apify.com/pink_comic/sec-form-d-startup-funding-leads.md), [Metal](https://www.metal.so/guides/how-to-find-the-right-investors-for-your-startup-using-ai-in-2026/), [Papermark licence](https://www.stork.ai/en/papermark), [Ballerine 2023](https://techcrunch.com/2023/05/23/ballerine-brings-open-source-to-banks-risk-and-identity-decision-making)
- Avatars: [Ready Player Me shutdown](https://avatarsdk.com/blog/2026/01/15/switch-from-ready-player-me-to-avatar-sdk-fast-familiar-production-ready/), [platform status](https://avatarsdk.com/blog/2026/08/31/avatar-platforms-2026-whos-alive-whos-gone/)
