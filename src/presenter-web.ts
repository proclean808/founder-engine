// HTTP handler for the presenter system: POST /api/presenter { action, ... }.
import { HttpError, PROJECT_ROOT, accessFrom, lensFrom, packFrom, str } from "./web.js";
import { answerQuestion, PERSONAS, type Persona } from "./pitch.js";
import { listModels, providerFor } from "./provider.js";
import { approveAnswer, approveScript, createFaceSession, listProviders, planDelivery, synthesize, ApprovalError, DeliveryRefused, type ApprovedUtterance } from "./presenter.js";
import { bakeoffPack, runBakeoff } from "./bakeoff.js";

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
      case "bakeoff":
        return await runBakeoff(PROJECT_ROOT);
      default:
        throw new HttpError(400, "action must be providers, sample, deck, ask, speak, session or bakeoff");
    }
  } catch (e) {
    if (e instanceof DeliveryRefused) throw new HttpError(403, e.message);
    if (e instanceof ApprovalError) throw new HttpError(422, `not approved: ${e.message}`);
    throw e;
  }
}

