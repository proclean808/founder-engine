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

// ------------------------------------------------------------------ the investor's voice: barge-in detection + transcription
function useEar() {
  const Rec = typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition);
  const vad = useRef(null);

  /** Hear one spoken question. Resolves with the words, or null after silence. */
  const hear = useCallback((timeoutMs = 8000) => new Promise((resolve) => {
    if (!Rec) return resolve(null);
    const r = new Rec();
    r.lang = "en-US"; r.interimResults = false; r.maxAlternatives = 1;
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(t); try { r.stop(); } catch {} resolve(v); } };
    const t = setTimeout(() => finish(null), timeoutMs);
    r.onresult = (e) => finish(e.results[0][0].transcript);
    r.onerror = () => finish(null);
    r.onend = () => finish(null);
    try { r.start(); } catch { finish(null); }
  }), [Rec]);

  /** Watch the microphone while a presenter speaks; call onSpeech when the investor starts talking. */
  const watch = useCallback(async (onSpeech) => {
    unwatch();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      src.connect(an);
      const buf = new Float32Array(an.fftSize);
      let floor = 0.01, above = 0, raf = 0, armedAt = performance.now() + 600;
      const loop = () => {
        an.getFloatTimeDomainData(buf);
        let sum = 0; for (const x of buf) sum += x * x;
        const rms = Math.sqrt(sum / buf.length);
        floor = Math.min(0.08, floor * 0.995 + rms * 0.005); // adapts to the room
        if (performance.now() > armedAt && rms > Math.max(0.035, floor * 3.2)) above++; else above = Math.max(0, above - 1);
        if (above > 14) { above = 0; armedAt = performance.now() + 1500; onSpeech(); }
        raf = requestAnimationFrame(loop);
      };
      loop();
      vad.current = { stream, ctx, stop: () => cancelAnimationFrame(raf) };
      return true;
    } catch {
      return false;
    }
  }, []);

  const unwatch = useCallback(() => {
    const v = vad.current; vad.current = null;
    if (!v) return;
    v.stop(); v.stream.getTracks().forEach((t) => t.stop()); v.ctx.close().catch(() => {});
  }, []);

  return { canHear: Boolean(Rec), hear, watch, unwatch };
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
  const [sel, setSel] = useState(() => store.get("fe-presenter-sel", { face: "native", voice: "native", model: "none", captions: false }));
  const [lens, setLens] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [idx, setIdx] = useState(0);
  const [mode, setMode] = useState("idle"); // idle | presenting | listening | thinking | answering | done
  const [speaker, setSpeaker] = useState(null);
  const [current, setCurrent] = useState(null); // the utterance being spoken (for captions and evidence)
  const [interruptMs, setInterruptMs] = useState([]);
  const [notice, setNotice] = useState(null);
  const [openFact, setOpenFact] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const voice = useSpeaker();
  const ear = useEar();
  const live = useRef(false);
  const pos = useRef(0);

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
      setDeck(d); setIdx(0); pos.current = 0; setError(null);
    } catch (e) { setError(e.message); }
  }, [pack, sel.face, sel.voice, lens, accessToken]);
  useEffect(() => { buildDeck(); }, [buildDeck]);

  const factsById = useMemo(() => Object.fromEntries((deck?.facts ?? []).map((f) => [f.id, f])), [deck]);

  const say = useCallback(async (u) => {
    setCurrent(u); setSpeaker(u.persona);
    const r = await voice.speak(u, sel, accessToken || undefined);
    if (r.note) setNotice(r.note);
    setSpeaker(null);
    return r.done;
  }, [voice, sel, accessToken]);

  // The conversation loop: present, and whenever the investor speaks, stop, listen, answer, then carry on.
  const converse = useCallback(async () => {
    if (!deck || live.current) return;
    live.current = true;
    const onSpeech = () => { if (live.current) barge(); };
    const ok = await ear.watch(onSpeech);
    if (!ok) setNotice("Microphone access is needed so investors can interrupt by speaking.");
    let interrupted = false;
    const barge = async () => {
      if (interrupted) return;
      interrupted = true;
      const ms = await voice.interrupt();
      setInterruptMs((m) => [...m.slice(-4), ms]);
    };
    while (live.current) {
      // present until the end or until someone speaks
      setMode("presenting");
      interrupted = false;
      while (pos.current < deck.utterances.length && live.current && !interrupted) {
        setIdx(pos.current);
        const finished = await say(deck.utterances[pos.current]);
        if (finished) pos.current++;
      }
      if (!live.current) break;
      if (!interrupted) { setMode("listening"); } // deck finished: open the floor
      // answer questions until the investor goes quiet
      ear.unwatch();
      for (;;) {
        setMode("listening");
        const q = await ear.hear(interrupted ? 8000 : 15000);
        if (!q || !live.current) break;
        setMode("thinking");
        try {
          const r = await api({ action: "ask", pack, question: q, face: sel.face, voice: sel.voice, model: sel.model, access_token: accessToken || undefined });
          setMode("answering");
          await ear.watch(onSpeech);
          interrupted = false;
          await say({ ...r.utterance, question: q, mode: r.answer.mode });
          ear.unwatch();
        } catch (e) { setError(e.message); break; }
      }
      if (pos.current >= deck.utterances.length) { setMode("done"); break; }
      await ear.watch(onSpeech); // back to the deck
    }
    ear.unwatch();
    live.current = false;
  }, [deck, ear, voice, say, pack, sel, accessToken]);

  const stopAll = useCallback(() => { live.current = false; voice.stop(); ear.unwatch(); setSpeaker(null); setMode("idle"); }, [voice, ear]);
  const tapToTalk = useCallback(async () => {
    if (mode === "idle" || mode === "done") { if (mode === "done") pos.current = 0; return converse(); }
    if (mode === "presenting" || mode === "answering") { const ms = await voice.interrupt(); setInterruptMs((m) => [...m.slice(-4), ms]); }
  }, [mode, converse, voice]);

  const optFaces = (providers?.faces ?? []).map((p) => ({ id: p.id, name: p.name, state: p.state }));
  const optVoices = (providers?.voices ?? []).map((p) => ({ id: p.id, name: p.name, state: p.state }));
  const optModels = [{ id: "none", name: "Evidence only (no model)" }, ...(providers?.models ?? []).map((m) => ({ id: m.id, name: m.name, state: m.configured ? "ready" : "not-configured" }))];
  const shown = current ?? deck?.utterances?.[idx];
  const sceneFacts = (shown?.cites ?? []).map((id) => factsById[id]).filter(Boolean);
  const avgMs = interruptMs.length ? Math.round(interruptMs.reduce((a, b) => a + b, 0) / interruptMs.length) : null;
  const STATUS = { idle: "Tap to begin", presenting: "Speak any time to interrupt", listening: "Listening", thinking: "Checking the evidence", answering: "Speak to follow up", done: "Tap to hear it again" };
  const persona = speaker ?? shown?.persona ?? "founder";

  return (
    <div className="shell">
      <header className="top">
        <div className="brand"><b>LiveVibe</b> VentureLab<span>{deck?.title ?? "Presenter Studio"}</span></div>
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
          <label className="picker"><span>Captions</span>
            <select value={sel.captions ? "on" : "off"} onChange={(e) => setSel({ ...sel, captions: e.target.value === "on" })}><option value="off">Off</option><option value="on">On (accessibility)</option></select>
          </label>
          <label className="picker wide"><span>Access token (accredited investors)</span>
            <input value={accessToken} onChange={(e) => setAccessToken(e.target.value.trim())} placeholder="Issued by the founder after third-party verification" />
          </label>
          <p className="fine">Interruption {avgMs === null ? "not measured yet" : `${interruptMs.at(-1)} ms last, ${avgMs} ms average (target 300 ms)`}. Fact base {deck?.facts_hash?.slice(0, 12)}. Unavailable choices fall back to the built-in presenter.</p>
        </section>
      )}

      {error && <div className="banner bad">{error}</div>}
      {notice && <div className="banner">{notice}</div>}
      {!ear.canHear && <div className="banner bad">This browser can't listen. Open the link in Chrome or Safari.</div>}

      <main className="stage voice-only">
        <div className="room">
          {["founder", "cto", "cfo"].map((p) => <Presenter key={p} role={p} active={persona === p} speaking={speaker === p} />)}
        </div>

        <button className={`talk ${mode}`} style={{ "--hue": ROLE[persona].hue }} onClick={tapToTalk} disabled={!deck} aria-label={STATUS[mode]}>
          <span className="talk-ring" /><span className="talk-ring" />
          <span className="talk-core">{mode === "thinking" ? "…" : ROLE[persona].mark}</span>
        </button>
        <div className="status">{STATUS[mode]}</div>

        {sel.captions && shown && <p className="caption">{shown.question ? `“${shown.question}” — ` : ""}{shown.speech}</p>}

        <div className="evidence" style={{ "--hue": ROLE[persona].hue }}>
          {sceneFacts.map((f) => (
            <button key={f.id} className={`cite ${f.restricted ? "lock" : ""}`} onClick={() => setOpenFact(openFact === f.id ? null : f.id)}>{f.kind.replace(/_/g, " ")}{f.restricted ? " · restricted" : ""}</button>
          ))}
        </div>
        {openFact && factsById[openFact] && <div className="fact"><b>{openFact}</b> {factsById[openFact].text}<span>Source: {factsById[openFact].source}</span></div>}

        {mode !== "idle" && <button className="ghost end" onClick={stopAll}>End</button>}
      </main>
    </div>
  );
}
