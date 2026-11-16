// Venture Studio services (Milestone 3, Phase 1): durable venture record, deal flow, lessons.
// Persistence sits BEHIND the Milestone 1/2 engines: curation runs come from handleCurate, pitches
// from buildScript, answers from answerQuestion, unchanged. All tenant access goes through
// withTenant (RLS). Every mutation writes a hash-chained audit event in the same transaction.
//
// Governance:
//  - investor invitations require an explicit founder authorization statement naming the investor;
//    accredited access additionally requires a third-party verification reference
//  - automatic stage moves only go forward and never into human-outcome stages
//  - lessons are advisory: they are attached to runs as context and never change behaviour
//  - nothing here offers, negotiates, accepts or settles securities
import { randomBytes } from "node:crypto";
import type { Db, Tx } from "./db.js";
import { withTenant, withTx } from "./db.js";
import { tokenHash } from "./auth.js";
import { normalizePack, buildScript, answerQuestion, type AccessLevel, type FounderInputs, type RunPack } from "./pitch.js";
import { providerFromEnv } from "./provider.js";
import { detectRunner } from "./evidence.js";

export class StudioError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface StudioDeps {
  curate: (body: { intent: string; notes?: string }) => Promise<Record<string, unknown>>;
}

const STAGES = ["researching", "invited", "viewed", "qa", "followup", "founder_meeting", "interest_recorded", "passed"] as const;
export type Stage = (typeof STAGES)[number];
const HUMAN_ONLY: Stage[] = ["founder_meeting", "interest_recorded", "passed"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const need = (v: unknown, field: string, min = 1, max = 2000): string => {
  const s = typeof v === "string" ? v.trim() : "";
  if (s.length < min || s.length > max) throw new StudioError(400, `${field} must be ${min}-${max} characters`);
  return s;
};
const id = (v: unknown, field: string): string => {
  if (typeof v !== "string" || !UUID.test(v)) throw new StudioError(400, `${field} must be a uuid`);
  return v;
};

async function audit(tx: Tx, owner: string, e: { venture_id?: string | null; actor: string; action: string; entity: string; entity_id?: string | null; detail?: unknown }) {
  await tx.query(
    "INSERT INTO fe_audit_events(owner_id, venture_id, actor, action, entity, entity_id, detail, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,$6,$7,'','')",
    [owner, e.venture_id ?? null, e.actor, e.action, e.entity, e.entity_id ?? null, JSON.stringify(e.detail ?? {})],
  );
}

async function ownVenture(tx: Tx, ventureId: string) {
  const r = await tx.query("SELECT id, name, created_at FROM fe_ventures WHERE id = $1", [ventureId]);
  if (!r.rows[0]) throw new StudioError(404, "venture not found"); // also what another tenant sees
  return r.rows[0];
}

async function setStage(tx: Tx, owner: string, ventureId: string, investorId: string, to: Stage, actor: string, note: string | null, system: boolean) {
  const r = await tx.query("SELECT stage FROM fe_investors WHERE id = $1 AND venture_id = $2 FOR UPDATE", [investorId, ventureId]);
  if (!r.rows[0]) throw new StudioError(404, "investor not found");
  const from = r.rows[0].stage as Stage;
  if (from === to) return { from, to, changed: false };
  const fi = STAGES.indexOf(from), ti = STAGES.indexOf(to);
  if (system) {
    if (HUMAN_ONLY.includes(to) || HUMAN_ONLY.includes(from) || ti < fi) return { from, to: from, changed: false };
  } else {
    if (to !== "passed" && ti < fi) throw new StudioError(409, `stage can only move forward (${from} -> ${to} refused); use 'passed' to close`);
    if (from === "passed") throw new StudioError(409, "investor already passed");
  }
  await tx.query("UPDATE fe_investors SET stage = $1 WHERE id = $2", [to, investorId]);
  await tx.query("INSERT INTO fe_stage_transitions(owner_id, venture_id, investor_id, from_stage, to_stage, actor, note) VALUES ($1,$2,$3,$4,$5,$6,$7)", [owner, ventureId, investorId, from, to, actor, note]);
  await audit(tx, owner, { venture_id: ventureId, actor, action: "stage.transition", entity: "investor", entity_id: investorId, detail: { from, to, note } });
  return { from, to, changed: true };
}

// ---------------- Venture record ----------------

export async function createVenture(db: Db, uid: string, body: { name?: unknown }) {
  const name = need(body.name, "name", 1, 120);
  return withTenant(db, uid, async (tx) => {
    const r = await tx.query("INSERT INTO fe_ventures(owner_id, name) VALUES ($1,$2) RETURNING id, name, created_at", [uid, name]);
    await audit(tx, uid, { venture_id: r.rows[0].id, actor: `founder:${uid}`, action: "venture.create", entity: "venture", entity_id: r.rows[0].id, detail: { name } });
    return r.rows[0];
  });
}

export async function listVentures(db: Db, uid: string) {
  return withTenant(db, uid, async (tx) => (await tx.query("SELECT id, name, created_at FROM fe_ventures ORDER BY created_at DESC")).rows);
}

export async function relevantLessons(tx: Tx, component: string, environment: string, text = "", limit = 5) {
  const rows = (await tx.query(
    "SELECT l.* FROM fe_lessons l WHERE component = $1 AND environment IN ($2, 'any') AND NOT EXISTS (SELECT 1 FROM fe_lessons s WHERE s.supersedes = l.id) ORDER BY created_at DESC LIMIT 50",
    [component, environment],
  )).rows;
  const words = new Set(text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
  return rows
    .map((l) => ({ l, score: (String(l.symptom).toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter((w) => words.has(w)).length }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.l);
}

/** Run Milestone 1 curation (unchanged engine) and persist the full result. */
export async function createRun(db: Db, uid: string, ventureId: string, body: { intent?: unknown; notes?: unknown }, deps: StudioDeps) {
  const intent = need(body.intent, "intent", 20, 4000);
  const environment = detectRunner();
  const lessons = await withTenant(db, uid, async (tx) => {
    await ownVenture(tx, ventureId);
    return relevantLessons(tx, "curation", environment, intent);
  });
  const run = await deps.curate({ intent, ...(typeof body.notes === "string" && body.notes ? { notes: body.notes } : {}) });
  delete (run as { log?: unknown }).log;
  return withTenant(db, uid, async (tx) => {
    const r = await tx.query(
      "INSERT INTO fe_runs(owner_id, venture_id, intent, status, run, lessons_consulted) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, status, created_at",
      [uid, ventureId, intent, String(run.status), JSON.stringify(run), lessons.map((l) => l.id)],
    );
    await audit(tx, uid, { venture_id: ventureId, actor: `founder:${uid}`, action: "run.create", entity: "run", entity_id: r.rows[0].id, detail: { status: run.status, receipts: (run.receipts as unknown[] | undefined)?.length ?? 0, chain_intact: run.chain_intact, lessons_consulted: lessons.map((l) => l.id) } });
    return { ...r.rows[0], run, lessons_consulted: lessons.map((l) => ({ id: l.id, symptom: l.symptom, correction: l.correction, advisory: true })) };
  });
}

/** Generate and store a pitch version from a stored run (Milestone 2 engine, unchanged). */
export async function createPitch(db: Db, uid: string, ventureId: string, body: { run_id?: unknown; founder?: unknown }) {
  const runId = id(body.run_id, "run_id");
  return withTenant(db, uid, async (tx) => {
    await ownVenture(tx, ventureId);
    const run = (await tx.query("SELECT run FROM fe_runs WHERE id = $1 AND venture_id = $2", [runId, ventureId])).rows[0]?.run as RunPack | undefined;
    if (!run) throw new StudioError(404, "run not found");
    const pack = normalizePack({ run, founder: body.founder ?? {} });
    const built = buildScript(pack);
    const version = Number((await tx.query("SELECT coalesce(max(version),0)+1 AS v FROM fe_pitches WHERE venture_id = $1", [ventureId])).rows[0].v);
    const r = await tx.query(
      "INSERT INTO fe_pitches(owner_id, venture_id, run_id, version, founder, facts_hash, script) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, version, facts_hash, created_at",
      [uid, ventureId, runId, version, JSON.stringify(pack.founder), built.facts_hash, JSON.stringify(built.script)],
    );
    await audit(tx, uid, { venture_id: ventureId, actor: `founder:${uid}`, action: "pitch.create", entity: "pitch", entity_id: r.rows[0].id, detail: { version, run_id: runId, facts_hash: built.facts_hash, lines: built.script.length } });
    return { ...r.rows[0], title: built.title, script: built.script };
  });
}

// ---------------- Deal flow ----------------

export async function addInvestor(db: Db, uid: string, ventureId: string, body: Record<string, unknown>) {
  const name = need(body.name, "name", 1, 120);
  const focus = (Array.isArray(body.focus) ? body.focus : []).map(String).filter((f) => ["technical", "market", "financial"].includes(f));
  return withTenant(db, uid, async (tx) => {
    await ownVenture(tx, ventureId);
    const r = await tx.query(
      "INSERT INTO fe_investors(owner_id, venture_id, name, firm, email, focus, focus_basis) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
      [uid, ventureId, name, typeof body.firm === "string" ? body.firm.slice(0, 120) : null, typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 200) : null, focus, typeof body.focus_basis === "string" ? body.focus_basis.slice(0, 300) : null],
    );
    await tx.query("INSERT INTO fe_stage_transitions(owner_id, venture_id, investor_id, from_stage, to_stage, actor, note) VALUES ($1,$2,$3,NULL,'researching',$4,'added')", [uid, ventureId, r.rows[0].id, `founder:${uid}`]);
    await audit(tx, uid, { venture_id: ventureId, actor: `founder:${uid}`, action: "investor.add", entity: "investor", entity_id: r.rows[0].id, detail: { name, firm: r.rows[0].firm, focus } });
    return r.rows[0];
  });
}

/**
 * Invite an investor to a stored pitch version. Requires an explicit authorization statement that
 * names the investor: `I authorize inviting <investor name> to pitch v<version>`.
 */
export async function inviteInvestor(db: Db, uid: string, ventureId: string, body: Record<string, unknown>) {
  const investorId = id(body.investor_id, "investor_id");
  const pitchId = id(body.pitch_id, "pitch_id");
  const level = body.access_level === "accredited" ? "accredited" : body.access_level === "identified" ? "identified" : null;
  if (!level) throw new StudioError(400, "access_level must be identified or accredited");
  const verifiedBy = typeof body.verified_by === "string" ? body.verified_by.trim() : "";
  if (level === "accredited" && verifiedBy.length < 3) throw new StudioError(400, "accredited access requires verified_by: the third-party accreditation verification reference");
  const statement = need(body.authorization, "authorization", 10, 500);
  const days = Math.min(30, Math.max(1, Number(body.days ?? 7)));
  return withTenant(db, uid, async (tx) => {
    await ownVenture(tx, ventureId);
    const inv = (await tx.query("SELECT id, name FROM fe_investors WHERE id = $1 AND venture_id = $2", [investorId, ventureId])).rows[0];
    if (!inv) throw new StudioError(404, "investor not found");
    const pitch = (await tx.query("SELECT id, version FROM fe_pitches WHERE id = $1 AND venture_id = $2", [pitchId, ventureId])).rows[0];
    if (!pitch) throw new StudioError(404, "pitch not found");
    const expected = `I authorize inviting ${inv.name} to pitch v${pitch.version}`;
    if (!statement.toLowerCase().startsWith(expected.toLowerCase())) {
      throw new StudioError(400, `explicit authorization required: the statement must begin with "${expected}"`);
    }
    const token = randomBytes(32).toString("base64url");
    const r = await tx.query(
      `INSERT INTO fe_invitations(owner_id, venture_id, investor_id, pitch_id, access_level, verified_by, token_hash, authorized_by, authorization_statement, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$1,$8, now() + make_interval(days => $9)) RETURNING id, access_level, expires_at`,
      [uid, ventureId, investorId, pitchId, level, verifiedBy || null, tokenHash(token), statement, days],
    );
    await audit(tx, uid, { venture_id: ventureId, actor: `founder:${uid}`, action: "invitation.issue", entity: "invitation", entity_id: r.rows[0].id, detail: { investor_id: investorId, pitch_id: pitchId, access_level: level, verified_by: verifiedBy || null, authorization: statement, expires_at: r.rows[0].expires_at } });
    const stage = await setStage(tx, uid, ventureId, investorId, "invited", "system:invitation", null, true);
    return { ...r.rows[0], token, link_path: `/studio.html#invite=${token}`, stage, note: "The token is shown once and stored only as a hash." };
  });
}

export async function revokeInvitation(db: Db, uid: string, ventureId: string, invitationId: string) {
  return withTenant(db, uid, async (tx) => {
    const r = await tx.query("UPDATE fe_invitations SET revoked_at = now() WHERE id = $1 AND venture_id = $2 AND revoked_at IS NULL RETURNING id", [id(invitationId, "invitation_id"), ventureId]);
    if (!r.rows[0]) throw new StudioError(404, "active invitation not found");
    await audit(tx, uid, { venture_id: ventureId, actor: `founder:${uid}`, action: "invitation.revoke", entity: "invitation", entity_id: invitationId });
    return { revoked: true };
  });
}

async function loadPack(tx: Tx, pitchId: string) {
  const p = (await tx.query("SELECT p.id, p.version, p.founder, p.facts_hash, r.run FROM fe_pitches p JOIN fe_runs r ON r.id = p.run_id WHERE p.id = $1", [pitchId])).rows[0];
  if (!p) throw new StudioError(404, "pitch not found");
  return { pitch: p, pack: normalizePack({ run: p.run, founder: p.founder }) };
}

async function recordAnswer(tx: Tx, owner: string, ventureId: string, investorId: string, sessionId: string, pitchId: string, question: string, access: AccessLevel, actor: string) {
  const { pack } = await loadPack(tx, pitchId);
  const a = await answerQuestion(pack, question, providerFromEnv(), undefined, access);
  const q = await tx.query(
    "INSERT INTO fe_qa(owner_id, venture_id, session_id, question, persona, answer, cites, escalate, mode) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, at",
    [owner, ventureId, sessionId, question, a.persona, a.answer, a.cites, a.escalate, a.mode],
  );
  await audit(tx, owner, { venture_id: ventureId, actor, action: "qa.record", entity: "qa", entity_id: q.rows[0].id, detail: { session_id: sessionId, persona: a.persona, escalate: a.escalate, cites: a.cites, mode: a.mode } });
  await setStage(tx, owner, ventureId, investorId, "qa", "system:qa", null, true);
  let followup = null;
  if (a.escalate) {
    followup = (await tx.query("INSERT INTO fe_followups(owner_id, venture_id, investor_id, qa_id, text) VALUES ($1,$2,$3,$4,$5) RETURNING id, text, status", [owner, ventureId, investorId, q.rows[0].id, question])).rows[0];
    await audit(tx, owner, { venture_id: ventureId, actor, action: "followup.create", entity: "followup", entity_id: followup.id, detail: { question } });
    await setStage(tx, owner, ventureId, investorId, "followup", "system:escalation", null, true);
  }
  return { qa_id: q.rows[0].id, ...a, followup };
}

/** Founder records a session held in person/on a call; questions are answered by the same engine. */
export async function recordSession(db: Db, uid: string, ventureId: string, body: Record<string, unknown>) {
  const investorId = id(body.investor_id, "investor_id");
  const pitchId = id(body.pitch_id, "pitch_id");
  const questions = (Array.isArray(body.questions) ? body.questions : []).map((q) => need(q, "question", 3, 500)).slice(0, 50);
  return withTenant(db, uid, async (tx) => {
    await ownVenture(tx, ventureId);
    if (!(await tx.query("SELECT 1 FROM fe_investors WHERE id = $1 AND venture_id = $2", [investorId, ventureId])).rows[0]) throw new StudioError(404, "investor not found");
    await loadPack(tx, pitchId);
    const lvl = (await tx.query("SELECT access_level FROM fe_invitations WHERE investor_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY issued_at DESC LIMIT 1", [investorId])).rows[0]?.access_level as AccessLevel | undefined;
    const s = await tx.query("INSERT INTO fe_pitch_sessions(owner_id, venture_id, investor_id, pitch_id, channel) VALUES ($1,$2,$3,$4,'founder_recorded') RETURNING id, started_at", [uid, ventureId, investorId, pitchId]);
    await audit(tx, uid, { venture_id: ventureId, actor: `founder:${uid}`, action: "session.record", entity: "session", entity_id: s.rows[0].id, detail: { investor_id: investorId, pitch_id: pitchId, questions: questions.length } });
    await setStage(tx, uid, ventureId, investorId, "viewed", "system:session", null, true);
    const answers = [];
    for (const q of questions) answers.push(await recordAnswer(tx, uid, ventureId, investorId, s.rows[0].id, pitchId, q, lvl ?? "public", `founder:${uid}`));
    return { session_id: s.rows[0].id, access: lvl ?? "public", answers };
  });
}

export async function transitionStage(db: Db, uid: string, ventureId: string, investorId: string, body: Record<string, unknown>) {
  const to = String(body.to ?? "") as Stage;
  if (!STAGES.includes(to)) throw new StudioError(400, `to must be one of ${STAGES.join(", ")}`);
  const note = need(body.note, "note", 3, 500);
  return withTenant(db, uid, async (tx) => {
    await ownVenture(tx, ventureId);
    return setStage(tx, uid, ventureId, id(investorId, "investor_id"), to, `founder:${uid}`, note, false);
  });
}

// ---------------- Investor link (no founder session) ----------------

async function invitationContext<T>(db: Db, token: unknown, fn: (tx: Tx, inv: Record<string, string>) => Promise<T>) {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) throw new StudioError(401, "invitation token required");
  return withTx(db, async (tx) => {
    await tx.query("SELECT set_config('app.invite_token_hash', $1, true)", [tokenHash(token)]);
    const inv = (await tx.query("SELECT * FROM fe_invitations WHERE token_hash = $1", [tokenHash(token)])).rows[0];
    if (!inv || inv.revoked_at || new Date(inv.expires_at) < new Date()) throw new StudioError(401, "invitation invalid, expired or revoked");
    await tx.query("SELECT set_config('app.invite_token_hash', '', true)");
    await tx.query("SELECT set_config('app.user_id', $1, true)", [inv.owner_id]); // scope to the inviting tenant only
    return fn(tx, inv);
  });
}

export async function openInvitation(db: Db, token: unknown) {
  return invitationContext(db, token, async (tx, inv) => {
    const { pitch, pack } = await loadPack(tx, inv.pitch_id);
    const investor = (await tx.query("SELECT id, name, firm, focus, focus_basis FROM fe_investors WHERE id = $1", [inv.investor_id])).rows[0];
    const built = buildScript(pack, { access: inv.access_level as AccessLevel, lens: investor.focus?.length ? { investor: [investor.name, investor.firm].filter(Boolean).join(", "), focus: investor.focus, basis: investor.focus_basis ?? undefined } : undefined });
    const s = await tx.query("INSERT INTO fe_pitch_sessions(owner_id, venture_id, investor_id, pitch_id, invitation_id, channel) VALUES ($1,$2,$3,$4,$5,'investor_link') RETURNING id", [inv.owner_id, inv.venture_id, inv.investor_id, inv.pitch_id, inv.id]);
    await audit(tx, inv.owner_id, { venture_id: inv.venture_id, actor: `investor:${inv.investor_id}`, action: "session.open", entity: "session", entity_id: s.rows[0].id, detail: { invitation_id: inv.id, access: inv.access_level, facts_hash: built.facts_hash } });
    await setStage(tx, inv.owner_id, inv.venture_id, inv.investor_id, "viewed", "system:invitation_opened", null, true);
    return { ...built, session_id: s.rows[0].id, investor: { name: investor.name, firm: investor.firm }, pitch_version: pitch.version };
  });
}

export async function investorAsk(db: Db, token: unknown, body: Record<string, unknown>) {
  const question = need(body.question, "question", 3, 500);
  const sessionId = id(body.session_id, "session_id");
  return invitationContext(db, token, async (tx, inv) => {
    const s = (await tx.query("SELECT id FROM fe_pitch_sessions WHERE id = $1 AND invitation_id = $2", [sessionId, inv.id])).rows[0];
    if (!s) throw new StudioError(404, "session not found for this invitation");
    return recordAnswer(tx, inv.owner_id, inv.venture_id, inv.investor_id, sessionId, inv.pitch_id, question, inv.access_level as AccessLevel, `investor:${inv.investor_id}`);
  });
}

// ---------------- Lessons memory ----------------

/** Record a verified lesson. evidence_ref must be a stored run id or a receipt hash inside one. */
export async function addLesson(db: Db, uid: string, body: Record<string, unknown>) {
  const component = need(body.component, "component", 2, 80);
  const environment = need(body.environment, "environment", 2, 40);
  const symptom = need(body.symptom, "symptom", 5, 500);
  const cause = need(body.cause, "cause", 5, 1000);
  const correction = need(body.correction, "correction", 5, 1000);
  const evidence = need(body.evidence_ref, "evidence_ref", 8, 100);
  const supersedes = body.supersedes ? id(body.supersedes, "supersedes") : null;
  return withTenant(db, uid, async (tx) => {
    const proven = UUID.test(evidence)
      ? (await tx.query("SELECT 1 FROM fe_runs WHERE id = $1", [evidence])).rows[0]
      : (await tx.query("SELECT 1 FROM fe_runs WHERE run->'receipts' @> $1::jsonb LIMIT 1", [JSON.stringify([{ receipt_hash: evidence }])])).rows[0];
    if (!proven) throw new StudioError(422, "evidence_ref does not match a stored run or receipt: a lesson must be backed by verified evidence");
    const r = await tx.query(
      "INSERT INTO fe_lessons(owner_id, component, environment, symptom, cause, correction, evidence_ref, supersedes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
      [uid, component, environment, symptom, cause, correction, evidence, supersedes],
    );
    await audit(tx, uid, { actor: `founder:${uid}`, action: "lesson.record", entity: "lesson", entity_id: r.rows[0].id, detail: { component, environment, symptom, evidence_ref: evidence, supersedes } });
    return r.rows[0];
  });
}

export async function queryLessons(db: Db, uid: string, q: { component?: string; environment?: string; symptom?: string }) {
  return withTenant(db, uid, async (tx) => {
    if (q.component) return relevantLessons(tx, q.component, q.environment ?? "any", q.symptom ?? "", 20);
    return (await tx.query("SELECT * FROM fe_lessons ORDER BY created_at DESC LIMIT 50")).rows;
  });
}

// ---------------- History ----------------

export async function ventureHistory(db: Db, uid: string, ventureId: string) {
  return withTenant(db, uid, async (tx) => {
    const venture = await ownVenture(tx, ventureId);
    const q = async (sql: string) => (await tx.query(sql, [ventureId])).rows;
    const runs = await q("SELECT id, intent, status, created_at, lessons_consulted, run->'registry' AS registry, run->'receipts' AS receipts, run->>'chain_intact' AS chain_intact FROM fe_runs WHERE venture_id = $1 ORDER BY created_at");
    const pitches = await q("SELECT id, version, run_id, facts_hash, founder, jsonb_array_length(script) AS lines, created_at FROM fe_pitches WHERE venture_id = $1 ORDER BY version");
    const investors = await q("SELECT id, name, firm, email, focus, focus_basis, stage, created_at FROM fe_investors WHERE venture_id = $1 ORDER BY created_at");
    const transitions = await q("SELECT investor_id, from_stage, to_stage, actor, note, at FROM fe_stage_transitions WHERE venture_id = $1 ORDER BY at, id");
    const invitations = await q("SELECT id, investor_id, pitch_id, access_level, verified_by, authorization_statement, issued_at, expires_at, revoked_at FROM fe_invitations WHERE venture_id = $1 ORDER BY issued_at");
    const sessions = await q("SELECT id, investor_id, pitch_id, invitation_id, channel, started_at FROM fe_pitch_sessions WHERE venture_id = $1 ORDER BY started_at");
    const qa = await q("SELECT id, session_id, question, persona, answer, cites, escalate, mode, at FROM fe_qa WHERE venture_id = $1 ORDER BY at, id");
    const followups = await q("SELECT id, investor_id, qa_id, text, status, created_at FROM fe_followups WHERE venture_id = $1 ORDER BY created_at");
    const audit = await q("SELECT seq, actor, action, entity, entity_id, detail, at, prev_hash, hash FROM fe_audit_events WHERE venture_id = $1 ORDER BY seq");
    const chain = (await tx.query(
      `SELECT seq, hash = encode(sha256(convert_to(fe_audit_text(e), 'UTF8')), 'hex') AS hash_ok,
              prev_hash = coalesce(lag(hash) OVER (ORDER BY seq), 'genesis') AS link_ok
         FROM fe_audit_events e ORDER BY seq`,
    )).rows;
    const broken = chain.filter((c) => !c.hash_ok || !c.link_ok).map((c) => Number(c.seq));
    return {
      venture, runs, pitches, investors: investors.map((i) => ({ ...i, transitions: transitions.filter((t) => t.investor_id === i.id) })),
      invitations, sessions, qa, followups, audit,
      audit_chain: { events_in_tenant: chain.length, intact: broken.length === 0, broken_at: broken },
    };
  });
}
