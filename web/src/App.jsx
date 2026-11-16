import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ------------------------------------------------------------------ engine API
async function api(body) {
  const r = await fetch("/api/presenter", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

const ROLE = {
  founder: { short: "Founder", title: "Founder digital twin", mark: "F", hue: "var(--gold)" },
  cto: { short: "Co-CTO", title: "Co-CTO", mark: "T", hue: "var(--cyan)" },
  cfo: { short: "Co-CFO", title: "Co-CFO", mark: "$", hue: "var(--rose)" },
};

const STATE_LABEL = { ready: "Ready", "not-configured": "Needs keys", "configured-live-path-not-built": "Not built yet" };
const store = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };

// ------------------------------------------------------------------ speech driver (one speaker at a time, interruptible)
function useSpeaker() {
  const audio = useRef(null);
  const token = useRef(0);
  const nativeVoices = useRef([]);
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const load = () => (nativeVoices.current = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang)));
    load();
    speechSynthesis.onvoiceschanged = load;
  }, []);

  const stop = useCallback(() => {
    token.current++;
    if (audio.current) { audio.current.pause(); audio.current.src = ""; audio.current = null; }
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  }, []);

  const isSilent = () => !(audio.current && !audio.current.paused) && !("speechSynthesis" in window && speechSynthesis.speaking);

  /** Stop and measure how long until the room is actually silent. */
  const interrupt = useCallback(() => new Promise((resolve) => {
    const t0 = performance.now();
    stop();
    const tick = () => (isSilent() ? resolve(Math.round(performance.now() - t0)) : requestAnimationFrame(tick));
    tick();
  }), [stop]);

  const speakNative = (u, my) => new Promise((resolve) => {
    if (!("speechSynthesis" in window)) return setTimeout(resolve, Math.min(9000, 900 + u.speech.length * 45));
    const s = new SpeechSynthesisUtterance(u.speech);
    const vs = nativeVoices.current;
    const idx = { founder: 0, cto: 1, cfo: 2 }[u.persona] ?? 0;
    if (vs.length) s.voice = vs[Math.min(idx, vs.length - 1)];
    s.pitch = { founder: 1, cto: 0.9, cfo: 1.1 }[u.persona] ?? 1;
    s.rate = 1.02;
    s.onend = s.onerror = () => resolve(my === token.current);
    speechSynthesis.speak(s);
  });

  /** Speak one approved utterance with the selected voice. Resolves true when it finished, false if interrupted. */
  const speak = useCallback(async (u, sel, accessToken) => {
    stop();
    const my = ++token.current;
    let note = null;
    if (sel.voice !== "native") {
      try {
        const r = await api({ action: "speak", utterance: u, voice: sel.voice, face: sel.face, access_token: accessToken });
        if (my !== token.current) return { done: false };
        if (r.speech) {
          const a = new Audio(`data:${r.speech.mime};base64,${r.speech.audio_b64}`);
          audio.current = a;
          const done = await new Promise((res) => { a.onended = () => res(true); a.onerror = () => res(false); a.play().catch(() => res(false)); });
          return { done: done && my === token.current, via: r.speech.provider };
        }
        note = r.plan?.fallbacks?.join(" · ") || null;
      } catch (e) {
        note = `voice fell back to the built-in voice: ${e.message}`;
      }
    }
    const done = await speakNative(u, my);
    return { done, via: "native", note };
  }, [stop]);

  return { speak, interrupt, stop };
}

// ------------------------------------------------------------------ voice question input
function useListener() {
  const Rec = typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition);
  const listen = useCallback(() => new Promise((resolve) => {
    if (!Rec) return resolve(null);
    const r = new Rec();
    r.lang = "en-US"; r.interimResults = false; r.maxAlternatives = 1;
    r.onresult = (e) => resolve(e.results[0][0].transcript);
    r.onerror = r.onend = () => resolve(null);
    r.start();
  }), [Rec]);
  return { supported: Boolean(Rec), listen };
}

// ------------------------------------------------------------------ UI pieces
function Presenter({ role, active, speaking }) {
  const r = ROLE[role];
  return (
    <div className={`pres ${active ? "active" : ""} ${speaking ? "speaking" : ""}`} style={{ "--hue": r.hue }}>
      <div className="orb"><span>{r.mark}</span><i /><i /><i /></div>
      <div className="pres-name">{r.short}</div>
      <div className="pres-tag">Synthetic presenter</div>
    </div>
  );
}

function Picker({ label, value, options, onChange }) {
  return (
    <label className="picker">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.id} value={o.id}>{o.name}{o.state && o.state !== "ready" ? ` (${STATE_LABEL[o.state] ?? o.state})` : ""}</option>
        ))}
      </select>
    </label>
  );
}

// ------------------------------------------------------------------ app
export default function App() {
  const [providers, setProviders] = useState(null);
  const [pack, setPack] = useState(null);
  const [deck, setDeck] = useState(null);
  const [error, setError] = useState(null);
  const [sel, setSel] = useState(() => store.get("fe-presenter-sel", { face: "native", voice: "native", model: "none" }));
  const [lens, setLens] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speaker, setSpeaker] = useState(null);
  const [answer, setAnswer] = useState(null);
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState("");
  const [interruptMs, setInterruptMs] = useState([]);
  const [followUps, setFollowUps] = useState([]);
  const [notice, setNotice] = useState(null);
  const [openFact, setOpenFact] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const voice = useSpeaker();
  const ear = useListener();
  const playRef = useRef(false);

  useEffect(() => { store.set("fe-presenter-sel", sel); }, [sel]);

  useEffect(() => {
    api({ action: "providers" }).then(setProviders).catch((e) => setError(e.message));
    let run = null;
    try { run = JSON.parse(sessionStorage.getItem("fe-run")); } catch {}
    if (run?.spec) setPack({ run, founder: { venture_name: run.spec.venture_name } });
    else api({ action: "sample" }).then((r) => setPack(r.pack)).catch((e) => setError(e.message));
  }, []);

  const buildDeck = useCallback(async () => {
    if (!pack) return;
    try {
      const d = await api({ action: "deck", pack, face: sel.face, voice: sel.voice, lens: lens ? { focus: [lens] } : undefined, access_token: accessToken || undefined });
      setDeck(d); setIdx(0); setError(null);
    } catch (e) { setError(e.message); }
  }, [pack, sel.face, sel.voice, lens, accessToken]);
  useEffect(() => { buildDeck(); }, [buildDeck]);

  const factsById = useMemo(() => Object.fromEntries((deck?.facts ?? []).map((f) => [f.id, f])), [deck]);
  const line = deck?.utterances?.[idx];
  const plan = deck?.plans?.[idx];

  const playFrom = useCallback(async (start) => {
    if (!deck) return;
    playRef.current = true; setPlaying(true); setAnswer(null);
    for (let i = start; i < deck.utterances.length && playRef.current; i++) {
      setIdx(i);
      const u = deck.utterances[i];
      setSpeaker(u.persona);
      const r = await voice.speak(u, sel, accessToken || undefined);
      if (r.note) setNotice(r.note);
      if (!r.done) { setSpeaker(null); return; }
    }
    setSpeaker(null); playRef.current = false; setPlaying(false);
  }, [deck, sel, accessToken, voice]);

  const interrupt = useCallback(async () => {
    playRef.current = false; setPlaying(false);
    const ms = await voice.interrupt();
    setSpeaker(null);
    setInterruptMs((m) => [...m.slice(-4), ms]);
    setAsking(true);
    if (ear.supported) {
      const heard = await ear.listen();
      if (heard) setQuestion(heard);
    }
  }, [voice, ear]);

  const ask = useCallback(async (q) => {
    if (!q || q.trim().length < 3) return;
    setAsking(false); setQuestion("");
    try {
      const r = await api({ action: "ask", pack, question: q, face: sel.face, voice: sel.voice, model: sel.model, access_token: accessToken || undefined });
      setAnswer({ question: q, ...r });
      if (r.answer.escalate) setFollowUps((f) => [...f, { q, persona: r.answer.persona }]);
      setSpeaker(r.utterance.persona);
      const out = await voice.speak(r.utterance, sel, accessToken || undefined);
      if (out.note) setNotice(out.note);
      setSpeaker(null);
    } catch (e) { setError(e.message); }
  }, [pack, sel, accessToken, voice]);

  const optFaces = (providers?.faces ?? []).map((p) => ({ id: p.id, name: p.name, state: p.state }));
  const optVoices = (providers?.voices ?? []).map((p) => ({ id: p.id, name: p.name, state: p.state }));
  const optModels = [{ id: "none", name: "Evidence only (no model)" }, ...(providers?.models ?? []).map((m) => ({ id: m.id, name: m.name, state: m.configured ? "ready" : "not-configured" }))];
  const sceneFacts = (answer ? answer.utterance.cites : line?.cites ?? []).map((id) => factsById[id]).filter(Boolean);
  const current = answer ? answer.utterance : line;
  const avgMs = interruptMs.length ? Math.round(interruptMs.reduce((a, b) => a + b, 0) / interruptMs.length) : null;

  return (
    <div className="shell">
      <header className="top">
        <div className="brand"><b>LiveVibe</b> VentureLab<span>Presenter Studio</span></div>
        <button className="ghost" onClick={() => setShowSettings((s) => !s)} aria-expanded={showSettings}>Settings</button>
      </header>

      {showSettings && providers && (
        <section className="settings">
          <Picker label="Model" value={sel.model} options={optModels} onChange={(model) => setSel({ ...sel, model })} />
          <Picker label="Voice" value={sel.voice} options={optVoices} onChange={(v) => setSel({ ...sel, voice: v })} />
          <Picker label="Face" value={sel.face} options={optFaces} onChange={(face) => setSel({ ...sel, face })} />
          <label className="picker"><span>Investor lens</span>
            <select value={lens} onChange={(e) => setLens(e.target.value)}>
              <option value="">Standard order</option><option value="technical">Technical first</option><option value="market">Market first</option><option value="financial">Financial first</option>
            </select>
          </label>
          <label className="picker wide"><span>Access token (accredited investors)</span>
            <input value={accessToken} onChange={(e) => setAccessToken(e.target.value.trim())} placeholder="Issued by the founder after third-party verification" />
          </label>
          <p className="fine">Unavailable choices fall back to the built-in presenter and say why. The facts never change with the model, voice, face or lens. Fact base {deck?.facts_hash?.slice(0, 12)}.</p>
        </section>
      )}

      {error && <div className="banner bad">{error}</div>}
      {(notice || plan?.fallbacks?.length > 0) && <div className="banner">{notice || plan.fallbacks.join(" · ")}</div>}

      <main className="stage">
        <div className="room">
          {["founder", "cto", "cfo"].map((p) => <Presenter key={p} role={p} active={(current?.persona ?? "founder") === p} speaking={speaker === p} />)}
        </div>

        <article className="scene" style={{ "--hue": ROLE[current?.persona ?? "founder"].hue }}>
          <div className="eyebrow">{answer ? `Answer · ${ROLE[answer.utterance.persona].title}` : deck ? `${idx + 1} / ${deck.utterances.length} · ${ROLE[line?.persona ?? "founder"].title}` : "Loading the venture"}</div>
          <h1>{deck?.title ?? "…"}</h1>
          {answer && <p className="q">“{answer.question}”</p>}
          <p className="line">{current?.speech ?? ""}</p>
          {answer?.answer?.escalate && <p className="esc">Routed to the founder: no fact covers this, so nothing was guessed.</p>}
          <div className="cites">
            {sceneFacts.map((f) => (
              <button key={f.id} className={`cite ${f.restricted ? "lock" : ""}`} onClick={() => setOpenFact(openFact === f.id ? null : f.id)}>{f.id}{f.restricted ? " · restricted" : ""}</button>
            ))}
          </div>
          {openFact && factsById[openFact] && (
            <div className="fact"><b>{openFact}</b> {factsById[openFact].text}<span>Source: {factsById[openFact].source}</span></div>
          )}
        </article>

        <div className="controls">
          {!playing ? (
            <button className="primary" disabled={!deck} onClick={() => playFrom(answer ? idx : idx)}>{idx === 0 && !answer ? "Present" : "Resume"}</button>
          ) : (
            <button className="primary hot" onClick={interrupt}>Interrupt</button>
          )}
          <button className="ghost" disabled={!deck || playing} onClick={() => { setAnswer(null); setIdx(Math.max(0, idx - 1)); }}>Back</button>
          <button className="ghost" disabled={!deck || playing} onClick={() => { setAnswer(null); setIdx(Math.min((deck?.utterances.length ?? 1) - 1, idx + 1)); }}>Next</button>
          <button className="ghost" onClick={() => { if (playing) interrupt(); else setAsking(true); }}>Ask</button>
        </div>

        {asking && (
          <form className="askbar" onSubmit={(e) => { e.preventDefault(); ask(question); }}>
            <input autoFocus value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={ear.supported ? "Listening… or type your question" : "Type your question"} />
            <button className="primary" type="submit">Ask</button>
          </form>
        )}

        <footer className="meta">
          <span>Interruption: {avgMs === null ? "not measured yet" : `${interruptMs.at(-1)} ms last, ${avgMs} ms average (target 300 ms or less)`}</span>
          {answer && <span>Answer mode: {answer.answer.mode}{answer.model !== "none" ? ` · model ${answer.model}` : ""}</span>}
        </footer>

        {followUps.length > 0 && (
          <section className="follow">
            <h2>Founder follow-up</h2>
            <ul>{followUps.map((f, i) => <li key={i}>{f.q} <em>({ROLE[f.persona].short})</em></li>)}</ul>
          </section>
        )}
      </main>
    </div>
  );
}
