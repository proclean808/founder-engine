// HTTP handler for the presenter system: POST /api/presenter { action, ... }.
import { HttpError, PROJECT_ROOT, accessFrom, lensFrom, packFrom, str } from "./web.js";
import { answerQuestion, PERSONAS, type Persona } from "./pitch.js";
import { listModels, providerFor } from "./provider.js";
import { approveAnswer, approveScript, createFaceSession, listProviders, planDelivery, synthesize, ApprovalError, DeliveryRefused, type ApprovedUtterance } from "./presenter.js";
import { bakeoffPack, runBakeoff } from "./bakeoff.js";
import { liveStatus, mintSession, presenterBrief, runTool, seats, LiveError, type LiveProviderId } from "./live.js";

const want = (b: Record<string, unknown>) => ({ face: typeof b.face === "string" ? b.face : "native", voice: typeof b.voice === "string" ? b.voice : "native" });

export async function handlePresenter(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  try {
    switch (b.action) {
      case "providers":
        return { ...listProviders(), models: listModels() };
      case "sample":
        return { pack: bakeoffPack(PROJECT_ROOT) };
      case "deck": {
        const pack = packFrom(b);
        const acc = accessFrom(b);
        const deck = approveScript(pack, { lens: lensFrom(b), access: acc.level });
        const plans = deck.utterances.map((u) => planDelivery(u, acc.level, want(b)));
        return { title: deck.title, facts: deck.facts, facts_hash: deck.facts_hash, lens: deck.lens, access: deck.access, viewer: acc.viewer, personas: PERSONAS, utterances: deck.utterances, plans, founder: pack.founder };
      }
      case "ask": {
        const pack = packFrom(b);
        const acc = accessFrom(b);
        const question = str(b.question, "question", 3, 500)!;
        const persona = typeof b.persona === "string" && b.persona in PERSONAS ? (b.persona as Persona) : undefined;
        const model = typeof b.model === "string" ? b.model : "none";
        const a = await answerQuestion(pack, question, providerFor(model), persona, acc.level);
        const u = approveAnswer(pack, question, a, acc.level);
        return { answer: a, utterance: u, plan: planDelivery(u, acc.level, want(b)), model: providerFor(model) ? model : "none" };
      }
      case "speak": {
        // Server voice synthesis. The utterance must carry this deployment's signature.
        const acc = accessFrom(b);
        const u = b.utterance as ApprovedUtterance;
        const plan = planDelivery(u, acc.level, want(b));
        if (plan.voice === "native") return { plan, speech: null };
        return { plan, speech: await synthesize(plan.voice, u) };
      }
      case "session":
        return await createFaceSession(want(b).face);
      case "live_status":
        return liveStatus();
      case "live_session": {
        // One short-lived native voice session for one presenter.
        const pack = packFrom(b);
        const acc = accessFrom(b);
        const persona = typeof b.persona === "string" && b.persona in PERSONAS ? (b.persona as Persona) : "founder";
        const provider = seats()[persona] as LiveProviderId;
        // Restricted facts reach a vendor's model only for an accredited viewer AND a provider the founder allowed.
        const includeRestricted = acc.level === "accredited" && process.env[`FE_PRESENTER_${provider.toUpperCase()}_RESTRICTED_OK`] === "1";
        const brief = presenterBrief(pack, persona, acc.level, { includeRestricted });
        const session = await mintSession(provider, brief, typeof b.voice === "string" ? b.voice : undefined);
        return { persona, ...session, guard: { allowed_numbers: brief.allowed_numbers, restricted_terms: brief.restricted_terms }, facts_hash: brief.facts_hash, sections: brief.sections };
      }
      case "live_tool": {
        const pack = packFrom(b);
        const acc = accessFrom(b);
        const name = str(b.name, "name", 3, 40)!;
        return await runTool(pack, acc.level, name, (b.args ?? {}) as Record<string, unknown>);
      }
      case "bakeoff":
        return await runBakeoff(PROJECT_ROOT);
      default:
        throw new HttpError(400, "action must be providers, sample, deck, ask, speak, session, live_status, live_session, live_tool or bakeoff");
    }
  } catch (e) {
    if (e instanceof DeliveryRefused) throw new HttpError(403, e.message);
    if (e instanceof ApprovalError) throw new HttpError(422, `not approved: ${e.message}`);
    if (e instanceof LiveError) throw new HttpError(503, e.message);
    throw e;
  }
}

