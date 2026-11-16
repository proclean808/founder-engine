// Milestone 3 Phase 1 acceptance, against a REAL PostgreSQL (skips without FE_TEST_DATABASE_URL).
// Flow: founder creates venture -> runs curation -> generates pitch -> invites investor -> Q&A ->
// advances deal stage -> logs out, logs in fresh -> retrieves the complete evidence history.
// Plus: tenant isolation (RLS), immutability, explicit invitation authorization, lessons evidence.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
import { migrate } from "../src/db.js";
import { route, type V1Request } from "../src/v1.js";

const URL = process.env.FE_TEST_DATABASE_URL;
const schema = `fe_t_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
let db: pg.Pool;
const sampleRun = () => JSON.parse(readFileSync("fixtures/sample-run.json", "utf8"));
const deps = { curate: async () => sampleRun() };

async function call(method: string, path: string, body?: unknown, token?: string, query: Record<string, string> = {}) {
  const req: V1Request = { method, path, query, body, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) } };
  return route(req, { db, deps });
}

before(async () => {
  if (!URL) return;
  const admin = new pg.Pool({ connectionString: URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  db = new pg.Pool({ connectionString: URL, options: `-c search_path=${schema}`, max: 4 });
  await migrate(db);
});
after(async () => {
  if (!URL) return;
  await db.end();
  const admin = new pg.Pool({ connectionString: URL });
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

const skip = !URL && "FE_TEST_DATABASE_URL not set";

test("M3P1 acceptance: create -> curate -> pitch -> invite -> Q&A -> stage -> fresh login -> full history", { skip }, async () => {
  // founder signs up
  const su = await call("POST", "auth/signup", { email: "Founder@Example.com", password: "correct horse battery staple" });
  assert.equal(su.status, 201);
  assert.match(String(su.headers?.["set-cookie"]), /HttpOnly; Secure; SameSite=Strict/);
  let token = (su.body as { token: string }).token;

  const v = await call("POST", "ventures", { name: "NoteFlow" }, token);
  assert.equal(v.status, 201);
  const vid = (v.body as { id: string }).id;

  const run = await call("POST", `ventures/${vid}/runs`, { intent: "A tool for small team leads that turns meeting notes into tasks with due dates like next Friday." }, token);
  assert.equal(run.status, 201, JSON.stringify(run.body));
  const runBody = run.body as { id: string; status: string; run: { receipts: { receipt_hash: string; kind: string }[] } };
  assert.equal(runBody.status, "Tested");

  const pitch = await call("POST", `ventures/${vid}/pitches`, { run_id: runBody.id, founder: { venture_name: "NoteFlow", ask: "Raising $150k pre-seed", assumptions: ["Price: $12 per team per month", "[restricted] Proprietary parser tuning cuts errors by 40%"] } }, token);
  assert.equal(pitch.status, 201, JSON.stringify(pitch.body));
  const pitchId = (pitch.body as { id: string; version: number }).id;
  assert.equal((pitch.body as { version: number }).version, 1);

  const inv = await call("POST", `ventures/${vid}/investors`, { name: "Jane Doe", firm: "Acme Ventures", email: "jane@acme.vc", focus: ["technical"], focus_basis: "public portfolio skews developer tools" }, token);
  assert.equal(inv.status, 201);
  const investorId = (inv.body as { id: string }).id;

  // explicit authorization is required
  const noAuth = await call("POST", `ventures/${vid}/invitations`, { investor_id: investorId, pitch_id: pitchId, access_level: "identified" }, token);
  assert.equal(noAuth.status, 400);
  const wrongAuth = await call("POST", `ventures/${vid}/invitations`, { investor_id: investorId, pitch_id: pitchId, access_level: "identified", authorization: "yes send it to everyone" }, token);
  assert.equal(wrongAuth.status, 400);
  assert.match((wrongAuth.body as { error: string }).error, /I authorize inviting Jane Doe to pitch v1/);
  const noVerify = await call("POST", `ventures/${vid}/invitations`, { investor_id: investorId, pitch_id: pitchId, access_level: "accredited", authorization: "I authorize inviting Jane Doe to pitch v1" }, token);
  assert.equal(noVerify.status, 400);
  assert.match((noVerify.body as { error: string }).error, /verified_by/);
  const invite = await call("POST", `ventures/${vid}/invitations`, { investor_id: investorId, pitch_id: pitchId, access_level: "accredited", verified_by: "VerifyCo ref A-1001", authorization: "I authorize inviting Jane Doe to pitch v1 after accreditation was verified" }, token);
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const inviteToken = (invite.body as { token: string }).token;

  // investor opens the link: accredited access unlocks the restricted fact; lens = technical
  const open = await call("POST", "invite/open", { token: inviteToken });
  assert.equal(open.status, 200, JSON.stringify(open.body));
  const ob = open.body as { session_id: string; access: string; facts: { text: string; restricted?: boolean }[]; script: { persona: string }[] };
  assert.equal(ob.access, "accredited");
  assert.ok(ob.facts.some((f) => f.restricted && /40%/.test(f.text)));
  assert.equal(ob.script.find((l) => l.persona !== "founder")?.persona, "cto");

  const a1 = await call("POST", "invite/ask", { token: inviteToken, session_id: ob.session_id, question: "What is your pricing?" });
  assert.equal(a1.status, 200);
  assert.match((a1.body as { answer: string }).answer, /\$12/);
  const a2 = await call("POST", "invite/ask", { token: inviteToken, session_id: ob.session_id, question: "What is the total addressable market?" });
  assert.equal((a2.body as { escalate: boolean }).escalate, true);
  assert.ok((a2.body as { followup: unknown }).followup);

  // founder also records a call
  const rec = await call("POST", `ventures/${vid}/sessions`, { investor_id: investorId, pitch_id: pitchId, questions: ["How did you test it?"] }, token);
  assert.equal(rec.status, 201, JSON.stringify(rec.body));

  // founder advances the deal stage (human-only stage); backwards is refused
  const st = await call("POST", `ventures/${vid}/investors/${investorId}/stage`, { to: "founder_meeting", note: "Call booked with Jane for Thursday" }, token);
  assert.equal(st.status, 200, JSON.stringify(st.body));
  const back = await call("POST", `ventures/${vid}/investors/${investorId}/stage`, { to: "invited", note: "oops" }, token);
  assert.equal(back.status, 409);

  // lessons: must be backed by stored evidence; then consulted (advisory) on the next run
  const bogus = await call("POST", "lessons", { component: "curation", environment: "local", symptom: "npm search returned republished forks first", cause: "x".repeat(10), correction: "rank by canonical repository", evidence_ref: "deadbeefdeadbeef" }, token);
  assert.equal(bogus.status, 422);
  const receipt = runBody.run.receipts.find((r) => r.kind === "acceptance")!.receipt_hash;
  const lesson = await call("POST", "lessons", { component: "curation", environment: "local", symptom: "date parser candidates included republished forks", cause: "registry search returns copies of the same upstream repository", correction: "collapse candidates by canonical repository URL before vetting", evidence_ref: receipt }, token);
  assert.equal(lesson.status, 201, JSON.stringify(lesson.body));
  const run2 = await call("POST", `ventures/${vid}/runs`, { intent: "Same venture: date parser candidates for due dates in meeting notes, rerun." }, token);
  assert.ok((run2.body as { lessons_consulted: { id: string; advisory: boolean }[] }).lessons_consulted.some((l) => l.id === (lesson.body as { id: string }).id && l.advisory));

  // fresh login: logout kills the session; a new login sees everything
  assert.equal((await call("POST", "auth/logout", {}, token)).status, 200);
  assert.equal((await call("GET", `ventures/${vid}/history`, undefined, token)).status, 401);
  const li = await call("POST", "auth/login", { email: "founder@example.com", password: "correct horse battery staple" });
  assert.equal(li.status, 200);
  token = (li.body as { token: string }).token;
  const h = await call("GET", `ventures/${vid}/history`, undefined, token);
  assert.equal(h.status, 200);
  const hist = h.body as Record<string, any>;
  assert.equal(hist.runs.length, 2);
  assert.ok(hist.runs[0].receipts.length >= 8);
  assert.equal(hist.pitches.length, 1);
  assert.deepEqual(hist.investors[0].transitions.map((t: { to_stage: string }) => t.to_stage), ["researching", "invited", "viewed", "qa", "followup", "founder_meeting"]);
  assert.equal(hist.investors[0].stage, "founder_meeting");
  assert.equal(hist.invitations.length, 1);
  assert.ok(!JSON.stringify(hist.invitations).includes(inviteToken), "token never stored or returned");
  assert.equal(hist.sessions.length, 2);
  assert.equal(hist.qa.length, 3);
  assert.equal(hist.followups.length, 1);
  assert.ok(hist.audit.length >= 12);
  assert.equal(hist.audit_chain.intact, true);
  const actions = hist.audit.map((a: { action: string }) => a.action);
  for (const x of ["venture.create", "run.create", "pitch.create", "investor.add", "invitation.issue", "session.open", "qa.record", "followup.create", "session.record", "stage.transition"]) assert.ok(actions.includes(x), x);
});

test("tenant isolation: another founder sees nothing, even raw queries without tenant context", { skip }, async () => {
  const a = (await call("POST", "auth/signup", { email: "a@iso.test", password: "aaaaaaaaaaaaaaaa" })).body as { token: string };
  const b = (await call("POST", "auth/signup", { email: "b@iso.test", password: "bbbbbbbbbbbbbbbb" })).body as { token: string };
  const v = (await call("POST", "ventures", { name: "Secret A" }, a.token)).body as { id: string };
  assert.equal((await call("GET", `ventures/${v.id}/history`, undefined, b.token)).status, 404);
  assert.deepEqual((await call("GET", "ventures", undefined, b.token)).body, []);
  assert.equal((await call("POST", `ventures/${v.id}/investors`, { name: "x" }, b.token)).status, 404);
  const raw = await db.query("SELECT count(*)::int AS n FROM fe_ventures");
  assert.equal(raw.rows[0].n, 0, "FORCE RLS: no tenant context, no rows");
  // a forged insert into another tenant is rejected by the policy
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    const bid = (await tx.query("SELECT id FROM fe_users WHERE email = 'b@iso.test'")).rows[0].id;
    await tx.query("SELECT set_config('app.user_id', $1, true)", [bid]);
    const aid = (await tx.query("SELECT id FROM fe_users WHERE email = 'a@iso.test'")).rows[0].id;
    await assert.rejects(tx.query("INSERT INTO fe_ventures(owner_id, name) VALUES ($1, 'forged')", [aid]), /row-level security/);
  } finally {
    await tx.query("ROLLBACK");
    tx.release();
  }
});

test("immutability: evidence rows cannot be updated, deleted or truncated; tampering by the owner is detected", { skip }, async () => {
  const s = (await call("POST", "auth/signup", { email: "imm@test.dev", password: "immutable-pass-1" })).body as { token: string; user_id: string };
  const v = (await call("POST", "ventures", { name: "Immutable" }, s.token)).body as { id: string };
  await call("POST", `ventures/${v.id}/runs`, { intent: "A tool for small team leads that turns meeting notes into tasks with due dates." }, s.token);
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    await tx.query("SELECT set_config('app.user_id', $1, true)", [s.user_id]);
    for (const sql of ["UPDATE fe_audit_events SET actor = 'mallory'", "DELETE FROM fe_runs", "TRUNCATE fe_audit_events"]) {
      await tx.query("SAVEPOINT x");
      await assert.rejects(tx.query(sql), /immutable evidence/);
      await tx.query("ROLLBACK TO SAVEPOINT x");
    }
    // The table owner can disable triggers; the hash chain still exposes the edit.
    await tx.query("ALTER TABLE fe_audit_events DISABLE TRIGGER fe_audit_events_no_update");
    await tx.query("UPDATE fe_audit_events SET detail = '{\"name\":\"rewritten\"}' WHERE action = 'venture.create'");
    await tx.query("ALTER TABLE fe_audit_events ENABLE TRIGGER fe_audit_events_no_update");
    await tx.query("COMMIT");
  } finally {
    tx.release();
  }
  const h = (await call("GET", `ventures/${v.id}/history`, undefined, s.token)).body as { audit_chain: { intact: boolean; broken_at: number[] } };
  assert.equal(h.audit_chain.intact, false);
  assert.equal(h.audit_chain.broken_at.length, 1);
});

test("revoked and unknown invitation tokens do not open; unauthenticated founder routes are refused", { skip }, async () => {
  const s = (await call("POST", "auth/signup", { email: "rev@test.dev", password: "revocation-pass-1" })).body as { token: string };
  const v = (await call("POST", "ventures", { name: "Rev" }, s.token)).body as { id: string };
  const r = (await call("POST", `ventures/${v.id}/runs`, { intent: "A tool for small team leads that turns meeting notes into tasks with due dates." }, s.token)).body as { id: string };
  const p = (await call("POST", `ventures/${v.id}/pitches`, { run_id: r.id, founder: {} }, s.token)).body as { id: string };
  const i = (await call("POST", `ventures/${v.id}/investors`, { name: "Sam Angel" }, s.token)).body as { id: string };
  const inv = (await call("POST", `ventures/${v.id}/invitations`, { investor_id: i.id, pitch_id: p.id, access_level: "identified", authorization: "I authorize inviting Sam Angel to pitch v1" }, s.token)).body as { id: string; token: string };
  assert.equal((await call("POST", "invite/open", { token: inv.token })).status, 200);
  assert.equal((await call("POST", `ventures/${v.id}/invitations/${inv.id}/revoke`, {}, s.token)).status, 200);
  assert.equal((await call("POST", "invite/open", { token: inv.token })).status, 401);
  assert.equal((await call("POST", "invite/open", { token: "x".repeat(43) })).status, 401);
  assert.equal((await call("GET", "ventures")).status, 401);
  assert.equal((await route({ method: "POST", path: "ventures", headers: { authorization: `Bearer ${s.token}`, "content-type": "text/plain" }, query: {}, body: "{}" }, { db, deps })).status, 415);
});
