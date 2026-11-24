// Audio engine: mixer graph, look-ahead scheduler, previews and offline WAV export.
// Every note plays an AudioBuffer rendered from its channel's formula (see synth.js).
import { getBuffer, soundJob, renderJob, hasBuffer, storeBuffer } from './synth.js';
import { noise } from './formula.js';
import { STEPS_PER_BAR, songLengthBars } from './project.js';
import { encodeWav } from './wav.js';

const LOOKAHEAD = 0.12; // seconds scheduled ahead
const TICK_MS = 25;
export const DEFAULT_KEY = 60; // pitch used by step-sequencer hits (C4)

export const secondsPerStep = (bpm) => 60 / bpm / 4;

// Notes that start on `step` of a pattern: [{channel, key, len, vel}]
function patternEventsAt(project, pattern, step) {
  const out = [];
  for (const ch of project.channels) {
    if (pattern.steps[ch.id]?.includes(step)) out.push({ ch, key: DEFAULT_KEY, len: 1, vel: 0.8 });
    for (const n of pattern.notes[ch.id] || []) if (n.step === step) out.push({ ch, key: n.key, len: n.len, vel: n.vel });
  }
  return out;
}

function eventsAt(project, mode, patternId, step) {
  if (mode === 'pattern') {
    const p = project.patterns.find((x) => x.id === patternId);
    return p ? patternEventsAt(project, p, step % (p.bars * STEPS_PER_BAR)) : [];
  }
  const out = [];
  for (const clip of project.playlist) {
    const p = project.patterns.find((x) => x.id === clip.pattern);
    if (!p) continue;
    const local = step - clip.bar * STEPS_PER_BAR;
    if (local >= 0 && local < p.bars * STEPS_PER_BAR) out.push(...patternEventsAt(project, p, local));
  }
  return out;
}

export function loopLengthSteps(project, mode, patternId) {
  if (mode === 'pattern') {
    const p = project.patterns.find((x) => x.id === patternId);
    return (p?.bars || 1) * STEPS_PER_BAR;
  }
  return Math.max(1, songLengthBars(project)) * STEPS_PER_BAR;
}

// Background workers that render sounds in parallel (one per spare CPU thread, up to 8).
let pool = null;
function workerPool() {
  if (pool) return pool;
  pool = [];
  try {
    const count = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < count; i++) pool.push(new Worker(new URL('./render-worker.js', import.meta.url), { type: 'module' }));
  } catch {
    pool = []; // no worker support: render on the main thread instead
  }
  return pool;
}

function allEvents(project, mode, patternId) {
  const total = loopLengthSteps(project, mode, patternId);
  const out = [];
  for (let s = 0; s < total; s++) for (const e of eventsAt(project, mode, patternId, s)) out.push({ ...e, step: s });
  return out;
}

async function prepareOnMainThread(ctx, queue, onProgress, isCancelled) {
  let slice = performance.now();
  for (let i = 0; i < queue.length; i++) {
    storeBuffer(ctx, queue[i].id, renderJob(queue[i]));
    if (performance.now() - slice > 30) {
      onProgress?.((i + 1) / queue.length);
      await new Promise((r) => setTimeout(r, 0));
      if (isCancelled()) return false;
      slice = performance.now();
    }
  }
  return true;
}

// Renders every sound the events need into the cache, using all worker threads. Returns false if cancelled.
async function prepare(ctx, events, sps, onProgress, isCancelled = () => false) {
  const jobs = new Map();
  for (const e of events) {
    const job = soundJob(e.ch, e.key, e.len * sps, e.vel, ctx.sampleRate);
    if (!hasBuffer(job.id)) jobs.set(job.id, job);
  }
  const queue = [...jobs.values()].sort((a, b) => b.duration - a.duration); // longest first keeps all workers busy
  if (!queue.length) return true;
  const workers = workerPool();
  if (!workers.length) return prepareOnMainThread(ctx, queue, onProgress, isCancelled);

  const total = queue.length;
  let done = 0, finished = false;
  return new Promise((resolve) => {
    const finish = (ok) => { if (!finished) { finished = true; resolve(ok); } };
    const complete = (worker, id, data) => {
      storeBuffer(ctx, id, data);
      done++;
      onProgress?.(done / total);
      if (done === total) finish(true); else feed(worker);
    };
    const feed = (worker) => {
      if (finished) return;
      if (isCancelled()) return finish(false);
      const job = queue.shift();
      if (!job) return;
      // If a worker fails, the main thread renders that job (and shows the real error if there is one).
      worker.onmessage = ({ data }) => complete(worker, job.id, data.error ? renderJob(job) : data.data);
      worker.onerror = (ev) => { ev.preventDefault(); complete(worker, job.id, renderJob(job)); };
      worker.postMessage(job);
    };
    workers.forEach(feed);
  });
}

// Deterministic stereo reverb impulse response (decaying reproducible noise).
function makeImpulse(ctx, seconds = 2.4) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const t = i / ctx.sampleRate;
      d[i] = noise(t + c * 17.31) * Math.exp(-3.2 * t) * (1 - Math.exp(-200 * t)) * 0.45;
    }
  }
  return ir;
}

// Builds the mixer for any context (live or offline): channel strips -> master bus.
function buildMixer(ctx, project, withMeters) {
  const sum = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const reverb = ctx.createConvolver();
  reverb.buffer = makeImpulse(ctx);
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.12;
  const post = ctx.createGain(); // limiter output or bypass joins here
  const master = ctx.createGain();
  const masterAnalyser = withMeters ? ctx.createAnalyser() : null;

  sum.connect(dry);
  sum.connect(reverb);
  reverb.connect(wet);
  const bus = ctx.createGain();
  dry.connect(bus);
  wet.connect(bus);
  post.connect(master);
  if (masterAnalyser) {
    masterAnalyser.fftSize = 2048;
    master.connect(masterAnalyser);
    masterAnalyser.connect(ctx.destination);
  } else {
    master.connect(ctx.destination);
  }

  const strips = new Map();
  const mixer = {
    ctx, sum, dry, wet, limiter, bus, post, master, masterAnalyser, strips, limiterOn: null,
    strip(ch) {
      let s = strips.get(ch.id);
      if (!s) {
        const gain = ctx.createGain();
        const pan = ctx.createStereoPanner();
        gain.connect(pan);
        let out = pan;
        let analyser = null;
        if (withMeters) {
          analyser = ctx.createAnalyser();
          analyser.fftSize = 1024;
          pan.connect(analyser);
          out = analyser;
        }
        out.connect(sum);
        s = { gain, pan, analyser };
        strips.set(ch.id, s);
      }
      return s;
    },
    sync(p) {
      // Live changes glide for 10 ms (no zipper noise); offline renders start at the exact values.
      const setParam = (param, value) => (withMeters ? param.setTargetAtTime(value, ctx.currentTime, 0.01) : param.setValueAtTime(value, 0));
      const anySolo = p.channels.some((c) => c.solo);
      for (const ch of p.channels) {
        const s = mixer.strip(ch);
        const audible = !ch.mute && (!anySolo || ch.solo);
        setParam(s.gain.gain, audible ? ch.volume : 0);
        setParam(s.pan.pan, ch.pan);
      }
      for (const [id, s] of strips) {
        if (!p.channels.some((c) => c.id === id)) {
          s.gain.disconnect();
          strips.delete(id);
        }
      }
      dry.gain.value = 1 - p.master.reverb * 0.5;
      wet.gain.value = p.master.reverb;
      setParam(master.gain, p.master.volume);
      if (mixer.limiterOn !== p.master.limiter) {
        bus.disconnect();
        limiter.disconnect();
        if (p.master.limiter) { bus.connect(limiter); limiter.connect(post); } else bus.connect(post);
        mixer.limiterOn = p.master.limiter;
      }
    },
    play(ch, key, seconds, vel, when) {
      const src = ctx.createBufferSource();
      src.buffer = getBuffer(ctx, ch, key, seconds, vel);
      src.connect(mixer.strip(ch).gain);
      src.start(when);
      return src;
    },
  };
  mixer.sync(project);
  return mixer;
}

export class Engine {
  constructor(getProject) {
    this.getProject = getProject;
    this.ctx = null;
    this.mixer = null;
    this.playing = false;
    this.mode = 'pattern';
    this.patternId = null;
    this.timer = null;
    this.sources = new Set();
    this.songStartStep = 0;
  }

  ensure() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.mixer = buildMixer(this.ctx, this.getProject(), true);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  sync() {
    if (this.mixer) this.mixer.sync(this.getProject());
  }

  track(src) {
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }

  preview(ch, key = DEFAULT_KEY, steps = 2) {
    this.ensure();
    const sec = steps * secondsPerStep(this.getProject().bpm);
    this.track(this.mixer.play(ch, key, sec, 0.8, this.ctx.currentTime + 0.005));
  }

  // Renders every sound the loop needs before starting, so playback never stalls.
  // Runs in small slices so the window stays responsive; returns false if cancelled.
  async prerender(mode, patternId, onProgress, isCancelled) {
    const p = this.getProject();
    return prepare(this.ctx, allEvents(p, mode, patternId), secondsPerStep(p.bpm), onProgress, isCancelled);
  }

  async play(mode, patternId, fromStep = 0, onProgress) {
    this.ensure();
    this.stop();
    const token = this.playToken;
    this.preparing = true;
    const ok = await this.prerender(mode, patternId, onProgress, () => token !== this.playToken);
    this.preparing = false;
    if (!ok || token !== this.playToken) return false;
    this.mode = mode;
    this.patternId = patternId;
    this.loopSteps = loopLengthSteps(this.getProject(), mode, patternId);
    this.anchorStep = fromStep % this.loopSteps;
    this.anchorTime = this.ctx.currentTime + 0.05;
    this.nextStep = this.anchorStep;
    this.nextTime = this.anchorTime;
    this.playing = true;
    this.timer = setInterval(() => this.schedule(), TICK_MS);
    this.schedule();
    return true;
  }

  schedule() {
    const p = this.getProject();
    const sps = secondsPerStep(p.bpm);
    this.loopSteps = loopLengthSteps(p, this.mode, this.patternId);
    while (this.nextTime < this.ctx.currentTime + LOOKAHEAD) {
      const step = this.nextStep % this.loopSteps;
      for (const e of eventsAt(p, this.mode, this.patternId, step)) {
        this.track(this.mixer.play(e.ch, e.key, e.len * sps, e.vel, this.nextTime));
      }
      this.nextStep = step + 1;
      this.nextTime += sps;
    }
  }

  // Keeps the playhead continuous when the tempo changes mid-play.
  retime() {
    if (!this.playing) return;
    const now = this.ctx.currentTime;
    this.anchorStep = this.position();
    this.anchorTime = now;
    this.nextTime = now + (Math.ceil(this.anchorStep) - this.anchorStep) * secondsPerStep(this.getProject().bpm);
    this.nextStep = Math.ceil(this.anchorStep) % this.loopSteps;
  }

  // Current playhead position in steps (fractional).
  position() {
    if (!this.playing) return 0;
    const elapsed = Math.max(0, this.ctx.currentTime - this.anchorTime);
    return (this.anchorStep + elapsed / secondsPerStep(this.getProject().bpm)) % this.loopSteps;
  }

  stop() {
    this.playToken = (this.playToken || 0) + 1; // also cancels a play() that is still preparing
    this.preparing = false;
    clearInterval(this.timer);
    this.timer = null;
    this.playing = false;
    for (const s of this.sources) { try { s.stop(); } catch { /* already stopped */ } }
    this.sources.clear();
  }

  meters() {
    if (!this.mixer) return null;
    const read = (an) => {
      if (!an) return 0;
      const d = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(d);
      let m = 0;
      for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]));
      return m;
    };
    const channels = {};
    for (const [id, s] of this.mixer.strips) channels[id] = read(s.analyser);
    return { master: read(this.mixer.masterAnalyser), channels };
  }

  scope(out) {
    if (!this.mixer?.masterAnalyser) return false;
    this.mixer.masterAnalyser.getFloatTimeDomainData(out);
    return true;
  }

  // Offline render of the song (or one pattern) through the full mixer. Returns a stereo AudioBuffer.
  async render(mode, patternId, sampleRate = 44100, onProgress) {
    const p = this.getProject();
    const total = loopLengthSteps(p, mode, patternId);
    const sps = secondsPerStep(p.bpm);
    const tail = 2.5; // lets the last notes and the reverb ring out
    const ctx = new OfflineAudioContext(2, Math.ceil((total * sps + tail) * sampleRate), sampleRate);
    const events = allEvents(p, mode, patternId);
    await prepare(ctx, events, sps, onProgress);
    const mixer = buildMixer(ctx, p, false);
    for (const e of events) mixer.play(e.ch, e.key, e.len * sps, e.vel, e.step * sps);
    return ctx.startRendering();
  }

  // 16-bit stereo WAV of the song (or one pattern).
  async exportWav(mode, patternId, sampleRate = 44100, onProgress) {
    const rendered = await this.render(mode, patternId, sampleRate, onProgress);
    return encodeWav([rendered.getChannelData(0), rendered.getChannelData(1)], sampleRate);
  }
}
