// Draft ventures live on this device until the venture record (database) is connected.
const KEY = "fe-ventures-v1";
const ACTIVE = "fe-active-venture";

export function loadVentures() {
  try { return JSON.parse(localStorage.getItem(KEY)) ?? []; } catch { return []; }
}
export function saveVentures(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage unavailable: the session still works */ }
}
export function loadActive() { try { return localStorage.getItem(ACTIVE); } catch { return null; } }
export function saveActive(id) { try { id ? localStorage.setItem(ACTIVE, id) : localStorage.removeItem(ACTIVE); } catch {} }

export function newVenture(name = "Untitled venture") {
  const id = (crypto.randomUUID?.() ?? String(Date.now()));
  return { id, name, created: Date.now(), updated: Date.now(), statement: null, spec: null, run: null, pitchOpened: false, activity: [] };
}

/** Pipeline steps derived from what the engine has actually returned, never from intent. */
export function steps(v) {
  const run = v?.run;
  const receipts = run?.receipts ?? [];
  const acceptance = receipts.filter((r) => r.kind === "acceptance");
  const test = acceptance.length ? (acceptance.every((r) => r.result === "PASS") ? "done" : "failed") : run ? "blocked" : "todo";
  return [
    { id: "define", n: "01", label: "Define", state: v?.spec ? "done" : "todo" },
    { id: "find", n: "02", label: "Find slices", state: run?.registry?.length ? "done" : "todo" },
    { id: "assemble", n: "03", label: "Assemble", state: run?.selected ? "done" : run ? "blocked" : "todo" },
    { id: "test", n: "04", label: "Test", state: test },
    { id: "launch", n: "05", label: "Launch", state: v?.pitchOpened ? "done" : "todo" },
  ];
}

export function nextAction(v) {
  if (!v || !v.spec) return { text: "Tell us what you want to make.", cta: "Start conversation", go: "talk" };
  if (!v.run) return { text: "Find the open-source building blocks for your venture.", cta: "Find slices", go: "find" };
  if (!v.run.selected) return { text: "No component passed vetting. Review what was blocked and why.", cta: "Review components", go: "openslice" };
  if (!v.pitchOpened) return { text: "Your stack is tested. Present it to an investor.", cta: "Create pitch", go: "pitch" };
  return { text: "Review the evidence trail before you share the pitch.", cta: "Open evidence", go: "evidence" };
}
