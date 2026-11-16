import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DRIVERS, Mic, sheriff } from "./live.js";

// ------------------------------------------------------------------ engine API
export async function api(body, path = "/api/presenter") {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

export const ROLE = {
  founder: { short: "Founder", title: "Founder digital twin", mark: "F", hue: "var(--gold)" },
  cto: { short: "Co-CTO", title: "Co-CTO", mark: "T", hue: "var(--cyan)" },
  cfo: { short: "Co-CFO", title: "Co-CFO", mark: "$", hue: "var(--rose)" },
};

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

// ------------------------------------------------------------------ the native live room
const PROVIDER_NAME = { openai: "ChatGPT voice", gemini: "Gemini Live", grok: "Grok Voice" };
const NEXT_UP = "You have the floor. Present your talking points now, in your own words, then call hand_off.";

export default function LiveRoom({ embedded = false }) {
  const [status, setStatus] = useState(null);
  const [pack, setPack] = useState(null);
  const [error, setError] = useState(null);
  const [accessToken, setAccessToken] = useState("");
  const [phase, setPhase] = useState("idle"); // idle | connecting | live | ended
  const [floor, setFloor] = useState("founder");
  const [listening, setListening] = useState(false);
  const [scene, setScene] = useState(null);
  const [evidence, setEvidence] = useState([]);
  const [openFact, setOpenFact] = useState(null);
  const [interruptMs, setInterruptMs] = useState([]);
  const [cuts, setCuts] = useState([]);
  const [followUps, setFollowUps] = useState([]);
  const [connected, setConnected] = useState({});
  const [showSettings, setShowSettings] = useState(false);
  const mic = useRef(null);
  const drivers = useRef({});
  const guards = useRef({});
  const floorRef = useRef("founder");
  const said = useRef({});
  const bargeAt = useRef(0);

  useEffect(() => {
    api({ action: "live_status" }).then(setStatus).catch((e) => setError(e.message));
    let run = null;
    try { run = JSON.parse(sessionStorage.getItem("fe-run")); } catch {}
    if (run?.spec) setPack({ run, founder: { venture_name: run.spec.venture_name } });
    else api({ action: "sample" }).then((r) => setPack(r.pack)).catch((e) => setError(e.message));
  }, []);

  const give = useCallback((to, instruction) => {
    const target = drivers.current[to];
    if (!target) return false;
    for (const [p, d] of Object.entries(drivers.current)) d.setActive(p === to);
    floorRef.current = to; setFloor(to);
    target.prompt(instruction);
    return true;
  }, []);

  const handlersFor = useCallback((persona) => ({
    onTranscript: (delta, rid) => {
      const cur = said.current[persona];
      const st = cur && cur.rid === rid ? cur : (said.current[persona] = { rid, text: "", cut: false });
      st.text += delta;
      if (st.cut) return;
      const reason = sheriff(st.text, guards.current[persona]);
      if (reason) {
        st.cut = true;
        const d = drivers.current[persona];
        d.cancel();
        setCuts((c) => [...c, { persona, reason }]);
        d.prompt("Stop. What you just started to say is not in the approved facts. Do not repeat it. In one sentence, say you don't have an approved answer for that and the founder will follow up personally, then call escalate_to_founder.");
      }
    },
    onTool: async ({ id, name, args }) => {
      const d = drivers.current[persona];
      try {
        const r = await api({ action: "live_tool", pack, access_token: accessToken || undefined, name, args });
        if (name === "hand_off" && r.ok) {
          const to = r.to;
          if (!drivers.current[to]) { d.toolResult(id, name, { ok: false, error: "That presenter is not connected. Answer within your own facts or escalate to the founder." }); return; }
          d.toolResult(id, name, { ok: true, note: "The floor has passed. Stay silent until you are given the floor again." }, false);
          give(to, r.question ? `The investor asked: "${r.question}". Answer it now from your facts, briefly, then hand back or continue your part.` : NEXT_UP);
          return;
        }
        if (name === "get_evidence") setEvidence(r.facts ?? []);
        if (name === "show_scene") setScene(r.section);
        if (name === "escalate_to_founder") setFollowUps((f) => [...f, { q: r.recorded, persona }]);
        d.toolResult(id, name, r);
      } catch (e) { d.toolResult(id, name, { ok: false, error: e.message }); }
    },
    onSpeechStarted: () => { if (floorRef.current === persona) { bargeAt.current = performance.now(); setListening(true); } },
    onSilent: () => {
      if (bargeAt.current && floorRef.current === persona) {
        const ms = Math.round(performance.now() - bargeAt.current);
        bargeAt.current = 0;
        setInterruptMs((m) => [...m.slice(-4), ms]);
      }
      setListening(false);
    },
    onError: (msg) => setError(`${ROLE[persona].short}: ${msg}`),
  }), [pack, accessToken, give]);

  const begin = useCallback(async () => {
    if (!pack || !status) return;
    setPhase("connecting"); setError(null);
    try {
      mic.current = new Mic();
      await mic.current.open();
      const ok = {};
      for (const seat of status.seats.filter((x) => x.ready)) {
        const s = await api({ action: "live_session", persona: seat.persona, pack, access_token: accessToken || undefined });
        guards.current[seat.persona] = s.guard;
        const d = new DRIVERS[s.provider](s, mic.current, handlersFor(seat.persona));
        await d.connect();
        drivers.current[seat.persona] = d;
        ok[seat.persona] = s.provider;
      }
      setConnected(ok);
      const first = ["founder", "cto", "cfo"].find((p) => drivers.current[p]);
      if (!first) throw new Error("No presenter could connect. Add the voice model keys in Vercel.");
      setPhase("live");
      give(first, first === "founder" ? "Begin the pitch now. Greet the investor, introduce the venture in your own words, then call hand_off to cto." : NEXT_UP);
    } catch (e) {
      setError(e.message.includes("Permission") || e.name === "NotAllowedError" ? "Microphone access is needed for a live conversation." : e.message);
      end();
    }
  }, [pack, status, accessToken, handlersFor, give]);

  const end = useCallback(() => {
    for (const d of Object.values(drivers.current)) d.close();
    drivers.current = {}; mic.current?.close(); mic.current = null;
    setConnected({}); setListening(false); setPhase((p) => (p === "connecting" ? "idle" : "ended"));
  }, []);
  useEffect(() => () => end(), [end]);

  const seatsList = status?.seats ?? [];
  const avgMs = interruptMs.length ? Math.round(interruptMs.reduce((a, b) => a + b, 0) / interruptMs.length) : null;
  const factById = useMemo(() => Object.fromEntries(evidence.map((f) => [f.id, f])), [evidence]);
  const label = phase === "idle" ? "Begin" : phase === "connecting" ? "Connecting" : phase === "ended" ? "Begin again" : listening ? "Listening" : "Live · just speak";

  return (
    <div className={embedded ? "shell embedded" : "shell"}>
      {!embedded && (      <header className="top">
        <div className="brand"><b>LiveVibe</b> VentureLab<span>{pack?.founder?.venture_name ?? pack?.run?.spec?.venture_name ?? "Live pitch"}</span></div>
        <button className="ghost" onClick={() => setShowSettings((s) => !s)} aria-expanded={showSettings}>Room</button>
      </header>)}

      {embedded && <button className="ghost room-toggle" onClick={() => setShowSettings((x) => !x)}>Room settings</button>}
      {showSettings && (
        <section className="settings">
          {seatsList.map((s) => (
            <div key={s.persona} className="seat-row"><b>{ROLE[s.persona].short}</b><span>{PROVIDER_NAME[s.provider]}</span><em className={s.ready ? "ok" : "no"}>{connected[s.persona] ? "connected" : s.ready ? "ready" : "needs key"}</em></div>
          ))}
          <label className="picker wide"><span>Access token (accredited investors)</span>
            <input value={accessToken} onChange={(e) => setAccessToken(e.target.value.trim())} placeholder="Issued by the founder after third-party verification" disabled={phase === "live"} />
          </label>
          <p className="fine">Barge-in: {avgMs === null ? "not measured yet" : `${interruptMs.at(-1)} ms last, ${avgMs} ms average (target 300 ms)`}. Guard cut-offs: {cuts.length}{cuts.length ? ` (last: ${cuts.at(-1).reason})` : ""}. Founder follow-ups: {followUps.length}.</p>
        </section>
      )}

      {error && <div className="banner bad">{error}</div>}
      {status && !status.ready && <div className="banner">{seatsList.filter((s) => !s.ready).map((s) => `${ROLE[s.persona].short} needs ${PROVIDER_NAME[s.provider]} (${status.providers.find((p) => p.id === s.provider)?.missing.join(", ")})`).join(" · ")}</div>}

      <main className="stage voice-only">
        <div className="room">
          {["founder", "cto", "cfo"].map((p) => <Presenter key={p} role={p} active={floor === p && phase === "live"} speaking={floor === p && phase === "live" && !listening} />)}
        </div>

        <button className={`talk ${phase === "live" ? (listening ? "listening" : "presenting") : phase}`} style={{ "--hue": ROLE[floor].hue }} onClick={phase === "live" || phase === "connecting" ? undefined : begin} disabled={!pack || !status || phase === "connecting"} aria-label={label}>
          <span className="talk-ring" /><span className="talk-ring" />
          <span className="talk-core">{ROLE[floor].mark}</span>
        </button>
        <div className="status">{label}</div>

        {scene && <h2 className="scene-title">{scene}</h2>}
        <div className="evidence" style={{ "--hue": ROLE[floor].hue }}>
          {evidence.map((f) => <button key={f.id} className="cite" onClick={() => setOpenFact(openFact === f.id ? null : f.id)}>{f.id}</button>)}
        </div>
        {openFact && factById[openFact] && <div className="fact"><b>{openFact}</b> {factById[openFact].text}<span>Source: {factById[openFact].source}</span></div>}

        {phase === "live" && <button className="ghost end" onClick={end}>End</button>}
      </main>
    </div>
  );
}
