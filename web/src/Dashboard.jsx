import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LiveRoom, { api } from "./LiveRoom.jsx";
import { DRIVERS, Mic } from "./live.js";
import { loadActive, loadVentures, newVenture, nextAction, saveActive, saveVentures, steps } from "./store.js";

// ------------------------------------------------------------------ icons (simple stroke glyphs)
const P = {
  home: "M3 10.5 12 3l9 7.5M5 9v11h14V9",
  layers: "m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5",
  cube: "m12 2 9 5v10l-9 5-9-5V7l9-5Zm0 0v10m9-5-9 5-9-5",
  hammer: "m14 6 4 4m-2-6 4 4-3 3-4-4 3-3ZM14 10 4 20l-1-1L13 9",
  screen: "M3 4h18v12H3zM8 20h8M12 16v4",
  shield: "M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Zm-3 9 2 2 4-4",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z",
  mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm-7 9a7 7 0 0 0 14 0M12 19v3",
  doc: "M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-4a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0-4a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z",
  flask: "M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3",
  rocket: "M5 15c-1 1-2 4-2 6 2 0 5-1 6-2m-1-4 5 5m-5-5c2-6 6-10 12-11-1 6-5 10-11 12m5-6a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z",
  tools: "m4 20 6-6m4-4 6-6M14 4l6 6-2 2-6-6 2-2ZM4 14l6 6",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l2 2H4l2-2Zm4 4a2 2 0 0 0 4 0",
  folder: "M3 6h6l2 2h10v11H3z",
  pulse: "M3 12h4l3-7 4 14 3-7h4",
  check: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-4-9 3 3 5-6",
  arrow: "M5 12h14m-6-6 6 6-6 6",
  chevron: "m6 9 6 6 6-6",
  stop: "M7 7h10v10H7z",
};
const Icon = ({ name, size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={P[name]} /></svg>
);

const NAV = [
  ["workspace", "Workspace", "home"], ["ventures", "Ventures", "layers"], ["openslice", "OpenSlice", "cube"],
  ["build", "Build", "hammer"], ["pitch", "Pitch Studio", "screen"], ["evidence", "Evidence", "shield"],
];
const STEP_ICON = { define: "target", find: "layers", assemble: "tools", test: "flask", launch: "rocket" };
const STEP_GO = { define: "talk", find: "openslice", assemble: "build", test: "evidence", launch: "pitch" };
const TEAM = [
  { id: "concierge", name: "Founder Concierge", role: "Your always-on partner for venture creation.", mark: "FC", hue: "#4f7cff" },
  { id: "builder", name: "Builder", role: "Turns your ideas into a working venture.", mark: "B", hue: "#f2b544" },
  { id: "reviewer", name: "Reviewer", role: "Checks quality, risks, and readiness to launch.", mark: "R", hue: "#43c59e" },
];

const useRoute = () => {
  const read = () => (location.hash.replace(/^#\/?/, "") || "workspace").split("?")[0];
  const [route, setRoute] = useState(read);
  useEffect(() => { const f = () => setRoute(read()); addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []);
  return [route, (r) => { location.hash = `/${r}`; }];
};

const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString(); };
const download = (name, data, type = "application/json") => {
  const url = URL.createObjectURL(new Blob([typeof data === "string" ? data : JSON.stringify(data, null, 2)], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name }); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// ------------------------------------------------------------------ app
export default function Dashboard() {
  const [route, go] = useRoute();
  const [ventures, setVentures] = useState(loadVentures);
  const [activeId, setActiveId] = useState(() => loadActive() ?? loadVentures()[0]?.id ?? null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(null); // "find" | "define" | null
  const [error, setError] = useState(null);
  const [drawer, setDrawer] = useState(null); // files | activity | approvals
  const [seen, setSeen] = useState(0);
  const venture = ventures.find((v) => v.id === activeId) ?? null;

  useEffect(() => { saveVentures(ventures); }, [ventures]);
  useEffect(() => { saveActive(activeId); }, [activeId]);
  useEffect(() => { api({ action: "status" }, "/api/workspace").then(setStatus).catch((e) => setError(e.message)); }, []);

  const update = useCallback((id, fn) => setVentures((list) => list.map((v) => (v.id === id ? { ...fn(v), updated: Date.now() } : v))), []);
  const log = useCallback((id, kind, text) => update(id, (v) => ({ ...v, activity: [{ t: Date.now(), kind, text }, ...(v.activity ?? [])].slice(0, 200) })), [update]);

  const ensureVenture = useCallback(() => {
    if (venture) return venture.id;
    const v = newVenture();
    setVentures((l) => [v, ...l]); setActiveId(v.id);
    return v.id;
  }, [venture]);

  // ---- engine actions (shared by buttons and the voice concierge)
  const define = useCallback(async (id, statement) => {
    setBusy("define");
    try {
      const { spec } = await api({ action: "define", statement }, "/api/workspace");
      update(id, (v) => ({ ...v, statement, spec, name: spec.venture_name || v.name, run: null, pitchOpened: false }));
      log(id, "define", `Venture defined: ${spec.venture_name} (${spec.extraction_method})`);
      return spec;
    } finally { setBusy(null); }
  }, [update, log]);

  const findSlices = useCallback(async (id) => {
    const v = ventures.find((x) => x.id === id);
    const intent = v?.statement ?? v?.spec?.founder_statement;
    if (!intent) throw new Error("Define the venture first.");
    setBusy("find");
    log(id, "build", "Builder started: discovery, vetting, integration and acceptance test");
    try {
      const run = await api({ intent }, "/api/curate");
      update(id, (x) => ({ ...x, run, spec: x.spec ?? run.spec }));
      log(id, "build", `Builder finished: ${run.status}${run.selected ? `, selected ${run.selected}` : ""}; evidence chain ${run.chain_intact ? "intact" : "BROKEN"}`);
      return run;
    } catch (e) {
      log(id, "error", `Builder failed: ${e.message}`);
      throw e;
    } finally { setBusy(null); }
  }, [ventures, update, log]);

  const loadSample = useCallback(async () => {
    const { pack } = await api({ action: "sample" });
    const v = { ...newVenture(pack.founder.venture_name), statement: pack.founder.one_liner, spec: pack.run.spec, run: pack.run, sample: true };
    v.activity = [{ t: Date.now(), kind: "define", text: "Sample venture loaded from the committed engine run (fixtures/sample-run.json)" }];
    setVentures((l) => [v, ...l]); setActiveId(v.id); go("workspace");
  }, [go]);

  const openPitch = useCallback(() => {
    if (!venture?.run) { setError("The pitch is built from an engine run. Find slices first."); return; }
    try { sessionStorage.setItem("fe-run", JSON.stringify(venture.run)); } catch {}
    update(venture.id, (v) => ({ ...v, pitchOpened: true }));
    log(venture.id, "pitch", "Pitch Studio opened with this venture's evidence");
    go("pitch");
  }, [venture, update, log, go]);

  // ---- the voice concierge (native speech-to-speech; no typing)
  const concierge = useConcierge({ status, venture, ensureVenture, define, findSlices, go, setError, log });

  const act = useCallback(async (what) => {
    setError(null);
    try {
      if (what === "talk") return concierge.start();
      if (what === "find") return venture && (await findSlices(venture.id));
      if (what === "pitch") return openPitch();
      go(what);
    } catch (e) { setError(e.message); }
  }, [venture, findSlices, openPitch, go, concierge]);


  const unread = (venture?.activity ?? []).filter((a) => a.t > seen).length;
  const s = steps(venture);
  const next = nextAction(venture);

  return (
    <div className={`dash ${route === "workspace" ? "" : "no-team"}`}>
      <aside className="side">
        <div className="logo"><span className="logo-mark">P1</span>PlatFormula.One</div>
        <div className="product">Founder Engine</div>
        <nav>
          {NAV.map(([id, label, icon]) => (
            <a key={id} href={`#/${id}`} className={route === id ? "on" : ""}><Icon name={icon} />{label}</a>
          ))}
          <hr />
          <a href="#/settings" className={route === "settings" ? "on" : ""}><Icon name="gear" />Settings</a>
        </nav>
      </aside>

      <div className="main">
        <header className="bar">
          <h1>{{ workspace: "Venture workspace", ventures: "Ventures", openslice: "OpenSlice", build: "Build", pitch: "Pitch Studio", evidence: "Evidence", settings: "Settings" }[route] ?? "Venture workspace"}</h1>
          <span className={`badge ${venture?.run?.selected ? "ok" : ""}`}><i />{venture ? (venture.sample ? "Sample venture" : venture.run?.selected ? "Tested venture" : "Draft venture") : "No venture"}</span>
          <div className="spacer" />
          <label className="choose">
            <select value={activeId ?? ""} onChange={(e) => setActiveId(e.target.value || null)} aria-label="Choose venture">
              {!ventures.length && <option value="">Choose venture</option>}
              {ventures.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
            <Icon name="chevron" size={18} />
          </label>
          <button className="bell" aria-label={`Activity, ${unread} new`} onClick={() => { setDrawer("activity"); setSeen(Date.now()); }}><Icon name="bell" />{unread > 0 && <i />}</button>
          <div className="me" title="Founder">PF</div>
        </header>

        {error && <div className="banner bad" onClick={() => setError(null)}>{error}</div>}

        <div className="content">
          {route === "workspace" && (
            <Workspace venture={venture} steps={s} next={next} busy={busy} concierge={concierge} status={status} act={act} loadSample={loadSample} />
          )}
          {route === "ventures" && <Ventures ventures={ventures} activeId={activeId} pick={(id) => { setActiveId(id); go("workspace"); }} remove={(id) => { setVentures((l) => l.filter((v) => v.id !== id)); if (id === activeId) setActiveId(null); }} create={() => { const v = newVenture(); setVentures((l) => [v, ...l]); setActiveId(v.id); go("workspace"); }} loadSample={loadSample} />}
          {route === "openslice" && <OpenSlice venture={venture} busy={busy} act={act} />}
          {route === "build" && <Build venture={venture} busy={busy} act={act} />}
          {route === "pitch" && (venture?.run ? <LiveRoom embedded key={venture.id} /> : <Empty icon="screen" title="No engine run yet" text="The pitch is built only from your venture's evidence. Find slices first." cta="Find slices" onClick={() => act(venture ? "find" : "talk")} />)}
          {route === "evidence" && <Evidence venture={venture} />}
          {route === "settings" && <Settings status={status} />}
        </div>

        <footer className="foot">
          <button onClick={() => setDrawer("files")}><Icon name="folder" />Project files</button><span>|</span>
          <button onClick={() => { setDrawer("activity"); setSeen(Date.now()); }}><Icon name="pulse" />Activity</button><span>|</span>
          <button onClick={() => setDrawer("approvals")}><Icon name="check" />Approvals</button>
        </footer>
      </div>

      {route === "workspace" && <Team venture={venture} busy={busy} concierge={concierge} next={next} act={act} />}

      {drawer && <Drawer kind={drawer} venture={venture} status={status} close={() => setDrawer(null)} />}
    </div>
  );
}

// ------------------------------------------------------------------ voice concierge
function useConcierge({ status, venture, ensureVenture, define, findSlices, go, setError, log }) {
  const [state, setState] = useState("idle"); // idle | connecting | live | speaking
  const ref = useRef({});
  const ventureRef = useRef(venture);
  ventureRef.current = venture;
  const ready = Boolean(status?.concierge?.ready);

  const stop = useCallback(() => { ref.current.driver?.close(); ref.current.mic?.close(); ref.current = {}; setState("idle"); }, []);
  useEffect(() => stop, [stop]);

  const start = useCallback(async () => {
    if (state !== "idle") return stop();
    if (!ready) { setError(`Voice needs a model key in Vercel: ${status?.concierge?.needs?.join(", ") ?? "checking…"}`); return; }
    setState("connecting");
    try {
      const id = ensureVenture();
      const v = ventureRef.current;
      const context = v?.spec ? JSON.stringify({ name: v.spec.venture_name, statement: v.statement, problem: v.spec.problem, target_user: v.spec.target_user, open_questions: v.spec.open_questions, run_status: v.run?.status ?? "not run", selected: v.run?.selected ?? null }) : null;
      const s = await api({ action: "concierge_session", context }, "/api/workspace");
      const mic = new Mic(); await mic.open();
      const handlers = {
        onTranscript: () => setState("speaking"),
        onSilent: () => setState("live"),
        onSpeechStarted: () => setState("live"),
        onError: (m) => setError(`Concierge: ${m}`),
        onTool: async ({ id: callId, name, args }) => {
          const d = ref.current.driver;
          try {
            let out;
            if (name === "define_venture") { const spec = await define(id, String(args.statement ?? "")); out = { ok: true, venture_name: spec.venture_name, problem: spec.problem, target_user: spec.target_user, capabilities: spec.capabilities.map((c) => c.id ?? c.name ?? c), open_questions: spec.open_questions }; go("workspace"); }
            else if (name === "find_slices") { go("openslice"); const run = await findSlices(id); out = { ok: true, status: run.status, selected: run.selected, components: (run.registry ?? []).map((r) => ({ name: r.name, version: r.version, license: r.license, status: r.status, reason: r.statusReason })), tests: (run.receipts ?? []).filter((r) => r.kind === "acceptance").map((r) => r.result), evidence_chain_intact: run.chain_intact }; }
            else if (name === "get_status") { const x = ventureRef.current; out = { venture: x?.spec?.venture_name ?? null, defined: Boolean(x?.spec), run_status: x?.run?.status ?? "not run", selected: x?.run?.selected ?? null, steps: steps(x).map((st) => `${st.label}: ${st.state}`) }; }
            else if (name === "open_section") { go(String(args.section)); out = { ok: true }; }
            else out = { ok: false, error: `unknown tool ${name}` };
            d.toolResult(callId, name, out);
          } catch (e) { d.toolResult(callId, name, { ok: false, error: e.message }); }
        },
      };
      const driver = new DRIVERS[s.provider](s, mic, handlers);
      await driver.connect();
      driver.setActive(true);
      ref.current = { driver, mic };
      setState("live");
      log(id, "voice", `Concierge connected (${status.concierge.name})`);
      driver.prompt(ventureRef.current?.spec ? "Greet the founder briefly, recap where this venture stands in one sentence, and ask what they want to do next." : "Greet the founder briefly and ask what they want to build today.");
    } catch (e) {
      setError(e.name === "NotAllowedError" ? "Microphone access is needed to talk with the Concierge." : e.message);
      stop();
    }
  }, [state, ready, status, ensureVenture, define, findSlices, go, setError, log, stop]);

  return { state, ready, start, stop, provider: status?.concierge?.name };
}

// ------------------------------------------------------------------ views
function Workspace({ venture, steps, busy, concierge, status, act, loadSample }) {
  const vision = venture?.spec;
  const talkLabel = { idle: "Tap to talk", connecting: "Connecting", live: "Listening · just speak", speaking: "Concierge speaking" }[concierge.state];
  return (
    <>
      <section className="hero">
        <h2>What are we building today?</h2>
        <div className="hero-row">
          <div className="card vision">
            <div className="card-h"><Icon name="doc" /><b>Your vision</b></div>
            {vision ? (
              <>
                <p className="v-name">{vision.venture_name}</p>
                <p className="mute">{vision.problem}</p>
                {vision.target_user && <p className="mute small">For: {vision.target_user}</p>}
                {vision.open_questions?.length > 0 && <p className="mute small">Open: {vision.open_questions.slice(0, 2).join(" · ")}</p>}
              </>
            ) : <p className="mute">Describe your venture, audience, and desired outcome.</p>}
          </div>
          <div className="talk-col">
            <button className={`mic ${concierge.state}`} onClick={concierge.start} aria-label={talkLabel} disabled={concierge.state === "connecting"}>
              <span className="mic-ring" /><span className="mic-ring" />
              <Icon name={concierge.state === "idle" ? "mic" : "stop"} size={46} />
            </button>
            <div className="talk-label">{talkLabel}</div>
            {!concierge.ready && status && <div className="hint">Voice needs a model key{!venture && <> · <button className="link" onClick={loadSample}>load the sample venture</button></>}</div>}
            {concierge.ready && concierge.state === "idle" && <div className="hint">{concierge.provider}</div>}
          </div>
        </div>
      </section>

      <ol className="steps">
        {steps.map((st) => (
          <li key={st.id} className={st.state}>
            <button onClick={() => act(STEP_GO[st.id])}><Icon name={STEP_ICON[st.id]} /><span>{st.n} {st.label}</span>{st.id === "find" && busy === "find" && <em className="spin" />}</button>
          </li>
        ))}
      </ol>

      <h3 className="sec">Your build</h3>
      <div className="cards3">
        <BuildCard icon="cube" tone="blue" title="OpenSlice" text={venture?.run ? `${venture.run.registry?.length ?? 0} components vetted · ${venture.run.selected ?? "none selected"}` : "Find components, compare licenses and select your stack."} cta="Explore components" onClick={() => act("openslice")} />
        <BuildCard icon="hammer" tone="amber" title="Build & verify" text={venture?.run ? `Run ${venture.run.status} · evidence chain ${venture.run.chain_intact ? "intact" : "broken"}` : "Connect your project, run the build and review evidence."} cta="Open build" onClick={() => act("build")} />
        <BuildCard icon="screen" tone="indigo" title="Pitch Studio" text="Create a conversational investor presentation." cta="Create pitch" onClick={() => act("pitch")} />
      </div>
    </>
  );
}

const BuildCard = ({ icon, tone, title, text, cta, onClick }) => (
  <div className="card bc">
    <div className="card-h"><span className={`ic ${tone}`}><Icon name={icon} /></span><b>{title}</b></div>
    <p className="mute">{text}</p>
    <button className="primary" onClick={onClick}>{cta}<Icon name="arrow" size={18} /></button>
  </div>
);

function Team({ venture, busy, concierge, next, act }) {
  const run = venture?.run;
  const st = {
    concierge: concierge.state === "idle" ? (concierge.ready ? "Ready" : "Needs a voice key") : concierge.state === "connecting" ? "Connecting" : "In conversation",
    builder: busy === "find" ? "Working: vetting and testing" : run ? `Last run: ${run.status}` : "Waiting for a defined venture",
    reviewer: run ? (run.chain_intact ? `${run.receipts?.length ?? 0} receipts · chain intact` : "Evidence chain BROKEN") : "Nothing to review yet",
  };
  return (
    <aside className="team">
      <h3>Your AI team</h3>
      {TEAM.map((m) => (
        <div key={m.id} className={`member ${m.id === "builder" && busy === "find" ? "working" : ""} ${m.id === "concierge" && concierge.state !== "idle" ? "working" : ""}`}>
          <div className="portrait" style={{ "--hue": m.hue }}>{m.mark}</div>
          <div><b>{m.name}</b><p>{m.role}</p><em>{st[m.id]}</em></div>
        </div>
      ))}
      <h3 className="na">Next action</h3>
      <p className="na-text"><Icon name="target" />{next.text}</p>
      <button className="primary wide" onClick={() => act(next.go)}>{next.cta}<Icon name="arrow" size={18} /></button>
    </aside>
  );
}

function Ventures({ ventures, activeId, pick, remove, create, loadSample }) {
  return (
    <div className="pane">
      <div className="pane-actions"><button className="primary" onClick={create}>New venture<Icon name="arrow" size={18} /></button><button className="ghost" onClick={loadSample}>Load sample venture</button></div>
      <p className="mute small">Drafts are saved on this device until the venture record database is connected.</p>
      {!ventures.length && <Empty icon="layers" title="No ventures yet" text="Start a conversation with the Concierge, or load the sample venture." />}
      <div className="list">
        {ventures.map((v) => {
          const s = steps(v);
          return (
            <div key={v.id} className={`row ${v.id === activeId ? "on" : ""}`}>
              <button className="row-main" onClick={() => pick(v.id)}>
                <b>{v.name}</b>
                <span className="mute small">{v.spec?.problem ?? "Not defined yet"} · updated {ago(v.updated)}</span>
                <span className="dots">{s.map((x) => <i key={x.id} className={x.state} title={`${x.label}: ${x.state}`} />)}</span>
              </button>
              <button className="ghost small" onClick={() => remove(v.id)} aria-label={`Delete ${v.name}`}>Delete</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function OpenSlice({ venture, busy, act }) {
  const run = venture?.run;
  if (!venture?.spec) return <Empty icon="cube" title="Define the venture first" text="Tell the Concierge what you want to make; OpenSlice then finds and vets the building blocks." cta="Start conversation" onClick={() => act("talk")} />;
  if (!run) return <Empty icon="cube" title={busy === "find" ? "Vetting components…" : "No components yet"} text={busy === "find" ? "Discovering candidates, checking tarball integrity, release tags and licences at the pinned commit, then running the acceptance test. Up to a minute." : `Capabilities needed: ${(venture.spec.capabilities ?? []).map((c) => c.id ?? c.name ?? c).join(", ") || "derived from your vision"}.`} cta={busy === "find" ? null : "Find slices"} onClick={() => act("find")} />;
  return (
    <div className="pane">
      <div className="pane-actions"><button className="ghost" disabled={busy === "find"} onClick={() => act("find")}>{busy === "find" ? "Running…" : "Run again"}</button></div>
      <div className="table">
        <div className="tr th"><span>Component</span><span>Capability</span><span>Licence</span><span>Pinned</span><span>Status</span></div>
        {(run.registry ?? []).map((r) => (
          <div key={`${r.name}@${r.version}`} className="tr">
            <span><b>{r.name}</b> <em className="mute">{r.version}</em>{r.repository && <a className="mute small block" href={r.repository} target="_blank" rel="noreferrer">{r.repository.replace(/^https?:\/\/(www\.)?/, "")}</a>}</span>
            <span>{r.capability}</span>
            <span>{r.license ?? "unknown"}</span>
            <span className="mono">{r.pinnedCommit ? r.pinnedCommit.slice(0, 10) : "–"}</span>
            <span><i className={`chip s-${String(r.status).toLowerCase()}`}>{r.status}</i><span className="mute small block">{r.statusReason}</span></span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Build({ venture, busy, act }) {
  const run = venture?.run;
  if (!run) return <Empty icon="hammer" title="Nothing built yet" text="The Builder integrates the selected component and runs its acceptance test." cta={venture?.spec ? "Find slices" : "Start conversation"} onClick={() => act(venture?.spec ? "find" : "talk")} />;
  const tests = (run.receipts ?? []).filter((r) => r.kind === "acceptance");
  return (
    <div className="pane grid2">
      <div className="card">
        <div className="card-h"><Icon name="hammer" /><b>Run {run.run_id ?? ""}</b></div>
        <dl className="kv">
          <dt>Status</dt><dd>{run.status} {run.status_reason ? `· ${run.status_reason}` : ""}</dd>
          <dt>Selected</dt><dd>{run.selected ?? "none"}</dd>
          <dt>Runner</dt><dd>{run.runner ?? "–"}</dd>
          <dt>Engine commit</dt><dd className="mono">{run.engine_commit?.slice(0, 10) ?? "–"}</dd>
          <dt>Acceptance</dt><dd>{tests.length ? tests.map((t) => t.result).join(", ") : "not run"}</dd>
          <dt>Evidence chain</dt><dd>{run.chain_intact ? "intact" : "BROKEN"}</dd>
        </dl>
        <button className="ghost" disabled={busy === "find"} onClick={() => act("find")}>{busy === "find" ? "Running…" : "Rebuild"}</button>
      </div>
      <div className="card">
        <div className="card-h"><Icon name="doc" /><b>Working artifact</b></div>
        {Array.isArray(run.artifact) && run.artifact.length ? (
          <ul className="items">{run.artifact.slice(0, 12).map((it, i) => <li key={i}>{it.text ?? it.task ?? JSON.stringify(it)}{it.due && <em className="mute"> · due {it.due}</em>}</li>)}</ul>
        ) : <p className="mute">No artifact produced in this run.</p>}
      </div>
      <div className="card span2">
        <div className="card-h"><Icon name="pulse" /><b>Build log</b></div>
        <pre className="log">{(run.log ?? []).join("\n") || "No log captured (sample run)."}</pre>
      </div>
    </div>
  );
}

function Evidence({ venture }) {
  const [open, setOpen] = useState(null);
  const receipts = venture?.run?.receipts ?? [];
  if (!receipts.length) return <Empty icon="shield" title="No evidence yet" text="Every engine step writes a hash-chained receipt. They appear here after the first run." />;
  return (
    <div className="pane">
      <p className={`chainline ${venture.run.chain_intact ? "ok" : "bad"}`}><Icon name="shield" />{receipts.length} receipts · hash chain {venture.run.chain_intact ? "intact" : "BROKEN"}</p>
      <div className="receipts">
        {receipts.map((r, i) => (
          <div key={r.receipt_hash ?? i} className="receipt">
            <button onClick={() => setOpen(open === i ? null : i)}>
              <i className={`chip r-${r.result?.toLowerCase()}`}>{r.result}</i><b>{r.kind}</b><span className="mute">{r.subject}</span><span className="mono mute small">{r.receipt_hash?.slice(0, 12)}</span>
            </button>
            {open === i && <pre className="log">{JSON.stringify({ inputs: r.inputs, outputs: r.outputs, created_at: r.created_at, environment: r.environment, prior: r.prior_receipt_hash }, null, 2).slice(0, 6000)}</pre>}
          </div>
        ))}
      </div>
    </div>
  );
}

function Settings({ status }) {
  if (!status) return <Empty icon="gear" title="Loading" text="Checking the engine." />;
  return (
    <div className="pane grid2">
      <div className="card">
        <div className="card-h"><Icon name="mic" /><b>Voice (native speech-to-speech)</b></div>
        {status.live.providers.map((p) => <div key={p.id} className="kvrow"><span>{p.name}<em className="mute small block">{p.model}</em></span><i className={`chip ${p.configured ? "s-tested" : "s-blocked"}`}>{p.configured ? "key set" : `needs ${p.missing.join(", ")}`}</i></div>)}
        <p className="mute small">Concierge: {status.concierge.ready ? status.concierge.name : "no voice key yet"}.</p>
      </div>
      <div className="card">
        <div className="card-h"><Icon name="screen" /><b>Pitch presenters</b></div>
        {status.live.seats.map((s) => <div key={s.persona} className="kvrow"><span>{s.title}</span><i className={`chip ${s.ready ? "s-tested" : "s-blocked"}`}>{s.provider} · {s.ready ? "ready" : "needs key"}</i></div>)}
        <p className="mute small">Change seating with FE_LIVE_SEATS in Vercel.</p>
      </div>
      <div className="card">
        <div className="card-h"><Icon name="layers" /><b>Venture record</b></div>
        <p className="mute">{status.database ? "Database connected." : "Database not connected: ventures are drafts saved on this device. Connect Postgres in Vercel (DATABASE_URL) to keep them in the venture record."}</p>
      </div>
      <div className="card">
        <div className="card-h"><Icon name="cube" /><b>Engine</b></div>
        <p className="mute mono small">{status.engine_commit ? status.engine_commit.slice(0, 12) : "local build"}</p>
      </div>
    </div>
  );
}

function Drawer({ kind, venture, close }) {
  const run = venture?.run;
  return (
    <div className="scrim" onClick={close}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <header><b>{{ files: "Project files", activity: "Activity", approvals: "Approvals" }[kind]}</b><button className="ghost small" onClick={close}>Close</button></header>
        {kind === "files" && (venture ? (
          <ul className="files">
            {venture.spec && <li><button onClick={() => download(`${slug(venture)}-spec.json`, venture.spec)}>venture-spec.json</button></li>}
            {run?.registry && <li><button onClick={() => download(`${slug(venture)}-registry.json`, run.registry)}>component-registry.json</button></li>}
            {run?.receipts && <li><button onClick={() => download(`${slug(venture)}-evidence.jsonl`, run.receipts.map((r) => JSON.stringify(r)).join("\n") + "\n", "application/x-ndjson")}>evidence.jsonl</button></li>}
            {run?.artifact && <li><button onClick={() => download(`${slug(venture)}-artifact.json`, run.artifact)}>working-artifact.json</button></li>}
            {!venture.spec && <li className="mute">No files yet.</li>}
          </ul>
        ) : <p className="mute">Choose a venture.</p>)}
        {kind === "activity" && (
          <ul className="activity">{(venture?.activity ?? []).map((a, i) => <li key={i}><em className={`k-${a.kind}`}>{a.kind}</em>{a.text}<span className="mute small block">{ago(a.t)}</span></li>)}{!venture?.activity?.length && <li className="mute">No activity yet.</li>}</ul>
        )}
        {kind === "approvals" && (
          <div className="mute">
            <p>Approvals hold the decisions only you can make: investor invitations (your explicit authorization statement), accredited access (needs a third-party verification) and questions the presenters escalated to you.</p>
            <p>These live in the venture record, which needs the production database. Nothing is waiting on this device.</p>
          </div>
        )}
      </aside>
    </div>
  );
}

const slug = (v) => (v.name || "venture").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const Empty = ({ icon, title, text, cta, onClick }) => (
  <div className="empty"><span className="ic blue"><Icon name={icon} size={28} /></span><b>{title}</b><p className="mute">{text}</p>{cta && <button className="primary" onClick={onClick}>{cta}<Icon name="arrow" size={18} /></button>}</div>
);
