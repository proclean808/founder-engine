// Native live drivers. Each presenter is a speech-to-speech session straight from the browser to the
// vendor: OpenAI Realtime over WebRTC, Gemini Live and Grok Voice over WebSocket. No STT, no TTS.
// All three expose the same small surface to the room:
//   connect(), setActive(bool), prompt(instruction), cancel(), toolResult(id, name, output), close()
// and emit: onTranscript(delta, responseId), onTool({id,name,args}), onSpeechStarted(), onSilent(), onError(msg)

// ------------------------------------------------------------ PCM plumbing for the WebSocket vendors
const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
}
registerProcessor("tap", Tap);`;

function toB64(int16) {
  const u8 = new Uint8Array(int16.buffer);
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Int16Array(u8.buffer);
}
function resample(f32, from, to) {
  if (from === to) return f32;
  const ratio = from / to, n = Math.floor(f32.length / ratio), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = f32[Math.floor(i * ratio)];
  return out;
}
function f32ToI16(f32) {
  const o = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) { const v = Math.max(-1, Math.min(1, f32[i])); o[i] = v < 0 ? v * 0x8000 : v * 0x7fff; }
  return o;
}

/** One shared microphone, fanned out to whichever presenter holds the floor. */
export class Mic {
  constructor() { this.stream = null; this.ctx = null; this.listeners = new Set(); }
  async open() {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    await this.ctx.audioWorklet.addModule(url);
    const src = this.ctx.createMediaStreamSource(this.stream);
    const tap = new AudioWorkletNode(this.ctx, "tap");
    tap.port.onmessage = (e) => { for (const l of this.listeners) l(e.data, this.ctx.sampleRate); };
    src.connect(tap);
  }
  track() { return this.stream.getAudioTracks()[0].clone(); }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  close() { this.stream?.getTracks().forEach((t) => t.stop()); this.ctx?.close().catch(() => {}); this.stream = null; }
}

/** Gapless playback of 16-bit PCM chunks, stoppable instantly for barge-in. */
class Player {
  constructor(rate) { this.rate = rate; this.ctx = new (window.AudioContext || window.webkitAudioContext)(); this.at = 0; this.nodes = new Set(); }
  play(int16) {
    const f = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) f[i] = int16[i] / 0x8000;
    const buf = this.ctx.createBuffer(1, f.length, this.rate);
    buf.copyToChannel(f, 0);
    const n = this.ctx.createBufferSource();
    n.buffer = buf; n.connect(this.ctx.destination);
    this.at = Math.max(this.at, this.ctx.currentTime + 0.02);
    n.start(this.at); this.at += buf.duration;
    this.nodes.add(n); n.onended = () => { this.nodes.delete(n); if (!this.nodes.size) this.onIdle?.(); };
  }
  stop() { for (const n of this.nodes) { try { n.stop(); } catch {} } this.nodes.clear(); this.at = 0; }
  get playing() { return this.nodes.size > 0; }
  close() { this.stop(); this.ctx.close().catch(() => {}); }
}

class Base {
  constructor(session, mic, h) { this.s = session; this.mic = mic; this.h = h; this.active = false; }
  setActive(v) { this.active = v; }
}

// ------------------------------------------------------------ OpenAI Realtime (WebRTC)
export class OpenAIDriver extends Base {
  async connect() {
    this.pc = new RTCPeerConnection();
    this.audio = new Audio(); this.audio.autoplay = true;
    this.pc.ontrack = (e) => { this.audio.srcObject = e.streams[0]; };
    this.track = this.mic.track();
    this.track.enabled = false;
    this.pc.addTrack(this.track);
    this.dc = this.pc.createDataChannel("oai-events");
    const opened = new Promise((r) => this.dc.addEventListener("open", r, { once: true }));
    this.dc.onmessage = (e) => this.event(JSON.parse(e.data));
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    const r = await fetch(this.s.connect, { method: "POST", body: offer.sdp, headers: { authorization: `Bearer ${this.s.secret}`, "content-type": "application/sdp" } });
    if (!r.ok) throw new Error(`OpenAI connect HTTP ${r.status}`);
    await this.pc.setRemoteDescription({ type: "answer", sdp: await r.text() });
    await opened;
  }
  send(o) { if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(o)); }
  event(e) {
    const t = e.type;
    if (t === "response.output_audio_transcript.delta" || t === "response.audio_transcript.delta") this.h.onTranscript(e.delta, e.response_id);
    else if (t === "response.function_call_arguments.done") this.h.onTool({ id: e.call_id, name: e.name, args: safe(e.arguments) });
    else if (t === "input_audio_buffer.speech_started") this.h.onSpeechStarted();
    else if (t === "output_audio_buffer.stopped" || t === "output_audio_buffer.cleared") this.h.onSilent();
    else if (t === "error") this.h.onError(e.error?.message ?? "OpenAI error");
  }
  setActive(v) { super.setActive(v); if (this.track) this.track.enabled = v; }
  prompt(text) {
    this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    this.send({ type: "response.create" });
  }
  cancel() { this.send({ type: "response.cancel" }); this.send({ type: "output_audio_buffer.clear" }); }
  toolResult(id, _name, output, speak = true) {
    this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: id, output: JSON.stringify(output) } });
    if (speak) this.send({ type: "response.create" });
  }
  close() { try { this.pc?.close(); } catch {} this.track?.stop(); }
}

// ------------------------------------------------------------ Grok Voice (WebSocket, OpenAI-compatible events)
export class GrokDriver extends Base {
  async connect() {
    this.player = new Player(24000);
    this.player.onIdle = () => this.h.onSilent();
    this.ws = new WebSocket(this.s.connect, [`xai-client-secret.${this.s.secret}`]);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error("Grok connection failed")); });
    this.ws.onmessage = (m) => this.event(JSON.parse(m.data));
    this.ws.onclose = () => this.h.onError?.("Grok session closed");
    this.send({ type: "session.update", session: { ...this.s.session, audio: { input: { format: { type: "audio/pcm", rate: 24000 } }, output: { format: { type: "audio/pcm", rate: 24000 } } } } });
    this.off = this.mic.on((f32, rate) => { if (this.active) this.send({ type: "input_audio_buffer.append", audio: toB64(f32ToI16(resample(f32, rate, 24000))) }); });
  }
  send(o) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(o)); }
  event(e) {
    const t = e.type;
    if (t === "response.output_audio.delta" || t === "response.audio.delta") this.player.play(fromB64(e.delta));
    else if (t === "response.output_audio_transcript.delta" || t === "response.audio_transcript.delta") this.h.onTranscript(e.delta, e.response_id);
    else if (t === "response.function_call_arguments.done") this.h.onTool({ id: e.call_id, name: e.name, args: safe(e.arguments) });
    else if (t === "input_audio_buffer.speech_started") { this.player.stop(); this.h.onSpeechStarted(); this.h.onSilent(); }
    else if (t === "error") this.h.onError(e.error?.message ?? "Grok error");
  }
  prompt(text) {
    this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    this.send({ type: "response.create" });
  }
  cancel() { this.send({ type: "response.cancel" }); this.player.stop(); }
  toolResult(id, _name, output, speak = true) {
    this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: id, output: JSON.stringify(output) } });
    if (speak) this.send({ type: "response.create" });
  }
  close() { this.off?.(); try { this.ws?.close(); } catch {} this.player?.close(); }
}

// ------------------------------------------------------------ Gemini Live (WebSocket, native audio)
export class GeminiDriver extends Base {
  async connect() {
    this.player = new Player(24000);
    this.player.onIdle = () => this.h.onSilent();
    this.ws = new WebSocket(this.s.connect);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error("Gemini connection failed")); });
    const ready = new Promise((r) => (this.onReady = r));
    this.ws.onmessage = async (m) => this.event(JSON.parse(typeof m.data === "string" ? m.data : await m.data.text()));
    this.ws.onclose = (e) => this.h.onError?.(`Gemini session closed${e.reason ? `: ${e.reason}` : ""}`);
    this.send({ setup: this.s.setup });
    await ready;
    this.turn = 0;
    this.off = this.mic.on((f32, rate) => { if (this.active) this.send({ realtimeInput: { audio: { data: toB64(f32ToI16(resample(f32, rate, 16000))), mimeType: "audio/pcm;rate=16000" } } }); });
  }
  send(o) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(o)); }
  event(e) {
    if (e.setupComplete) return this.onReady?.();
    if (e.toolCall) for (const c of e.toolCall.functionCalls ?? []) this.h.onTool({ id: c.id, name: c.name, args: c.args ?? {} });
    const sc = e.serverContent;
    if (!sc) return;
    if (sc.interrupted) { this.player.stop(); this.h.onSpeechStarted(); this.h.onSilent(); }
    for (const part of sc.modelTurn?.parts ?? []) if (part.inlineData?.data) this.player.play(fromB64(part.inlineData.data));
    if (sc.outputTranscription?.text) this.h.onTranscript(sc.outputTranscription.text, `g${this.turn}`);
    if (sc.turnComplete) this.turn++;
  }
  prompt(text) { this.send({ realtimeInput: { text } }); }
  cancel() { this.player.stop(); this.turn++; }
  toolResult(id, name, output) { this.send({ toolResponse: { functionResponses: [{ id, name, response: output }] } }); }
  close() { this.off?.(); try { this.ws?.close(); } catch {} this.player?.close(); }
}

export const DRIVERS = { openai: OpenAIDriver, grok: GrokDriver, gemini: GeminiDriver };

function safe(s) { try { return JSON.parse(s || "{}"); } catch { return {}; } }

// ------------------------------------------------------------ Sheriff: the live output guard
const NUM = /\d[\d,]*(?:\.\d+)?%?/g;
/** Returns a reason string when the streamed transcript says something it must not. */
export function sheriff(text, guard) {
  const allowed = new Set(guard.allowed_numbers);
  // only judge numbers that are complete (followed by a non-digit) so "1" of "12" is not flagged early
  for (const m of text.matchAll(NUM)) {
    const end = m.index + m[0].length;
    if (end >= text.length) continue;
    const n = m[0].replace(/,/g, "").replace(/%$/, "");
    if (!allowed.has(n)) return `unsourced number ${m[0]}`;
  }
  const low = text.toLowerCase();
  const hit = guard.restricted_terms.find((t) => low.includes(t));
  return hit ? `restricted term "${hit}"` : null;
}
