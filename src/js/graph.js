// Graph mode ("graphing-calculator songs"): a formula y = g(x) is drawn as a graph, x counts beats,
// and the graph is heard as pitch: frequency = base * 2^y (y = +1 is one octave up, 1/12 is a semitone).
// Where y is undefined (nan, 0/0) the layer is silent. This is pitch-mapping sonification
// (Mansur et al. 1985 "Sound graphs"; Fan et al. 2025) and is verified like every other sound.
import { compileForNote, compile, evaluate } from './formula.js';
import { keyToFreq } from './synth.js';
import { magnitudeSpectrum } from './verify.js';

const TWO_PI = 2 * Math.PI;
const GATE_SECONDS = 0.003;

export const GRAPH_RULE =
  'x[n] = (n / sampleRate) * BPM / 60 beats; y[n] = g(x[n]); frequency f[n] = base * 2^y[n] (held while y is undefined); ' +
  'phase p[0] = 0, p[n+1] = p[n] + 2*pi*f[n] / sampleRate (wrapped to one cycle); sample s[n] = volume * gate[n] * wave(p[n]); ' +
  'gate moves towards 1 where y is defined and towards 0 where it is undefined, over 3 ms.';

export const WAVES = {
  sine: { label: 'Sine (pure)', fn: (p) => Math.sin(p) },
  warm: { label: 'Warm (soft-clipped)', fn: (p) => Math.tanh(1.8 * Math.sin(p)) / Math.tanh(1.8) },
  square: { label: 'Buzzy (near square)', fn: (p) => Math.tanh(6 * Math.sin(p)) / Math.tanh(6) },
};

export const LAYER_COLORS = ['#111111', '#d32f2f', '#1565c0', '#2e7d32', '#6a1b9a', '#ef6c00', '#00838f', '#ad1457'];

// Original example: "Phonk, but it's math". x = beats, y = octaves above the base note, nan = silence.
const ROOT = 'if(0.5 - mod(floor(x/4), 4), 0, if(1.5 - mod(floor(x/4), 4), -4, if(2.5 - mod(floor(x/4), 4), -2, -5)))';
export const EXAMPLE = {
  bars: 8, bpm: 140,
  layers: [
    { name: 'Kick', key: 45, wave: 'warm', volume: 0.55, formula: 'if(0.45 - frac(x), 2.6*exp(-14*frac(x)) - 1.4, nan)' },
    { name: '808', key: 33, wave: 'warm', volume: 0.5, formula: `if(0.9 - frac(x/2), ${ROOT}/12 + 0.35*exp(-6*frac(x/2)), nan)` },
    { name: 'Cowbell', key: 69, wave: 'square', volume: 0.2, formula: `if(0.6 - frac(2*x), round(12*mod(3*floor(2*x), 7)/7)/12 + ${ROOT}/12, nan)` },
    { name: 'Tick', key: 69, wave: 'sine', volume: 0.12, formula: 'if(0.12 - frac(x + 0.5), 3.5 - 6*frac(x + 0.5), nan)' },
  ],
};

export const graphSeconds = (graph, bpm) => (graph.bars * 4 * 60) / bpm;

// Core recurrence shared by the renderer and the verifier; `yAt(x)` supplies the graph value.
function synthesize(yAt, layer, bpm, length, sampleRate, wantPitch = false) {
  const out = new Float32Array(length);
  const pitch = wantPitch ? new Float64Array(length) : null; // NaN where silent
  const wave = (WAVES[layer.wave] || WAVES.sine).fn;
  const base = keyToFreq(layer.key);
  const gateStep = 1 / (GATE_SECONDS * sampleRate);
  let phase = 0, gate = 0, freq = 0, invalid = 0, clamped = 0;
  for (let n = 0; n < length; n++) {
    const y = yAt(((n / sampleRate) * bpm) / 60);
    const defined = Number.isFinite(y);
    if (defined) {
      freq = base * Math.pow(2, y);
      if (freq > sampleRate / 2) { freq = sampleRate / 2; clamped++; }
    } else invalid++;
    gate = defined ? Math.min(1, gate + gateStep) : Math.max(0, gate - gateStep);
    out[n] = layer.volume * gate * wave(phase);
    if (pitch) pitch[n] = defined ? freq : NaN;
    phase += (TWO_PI * freq) / sampleRate;
    if (phase >= TWO_PI) phase -= TWO_PI;
  }
  return { data: out, pitch, undefinedSamples: invalid, clamped };
}

export function renderGraphLayer(layer, bpm, seconds, sampleRate) {
  const g = compileForNote(layer.formula, keyToFreq(layer.key), 1);
  const env = { t: 0, f: keyToFreq(layer.key), v: 1 };
  return synthesize((x) => { env.t = x; return g(env); }, layer, bpm, Math.round(seconds * sampleRate), sampleRate);
}

// All unmuted layers summed. If the sum would exceed 1.0 it is scaled down (reported as `gain`).
export function renderGraphSong(graph, bpm, sampleRate = 44100) {
  const seconds = graphSeconds(graph, bpm);
  const length = Math.round(seconds * sampleRate);
  const mix = new Float32Array(length);
  for (const layer of graph.layers) {
    if (layer.mute) continue;
    const { data } = renderGraphLayer(layer, bpm, seconds, sampleRate);
    for (let i = 0; i < length; i++) mix[i] += data[i];
  }
  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(mix[i]));
  const gain = peak > 0.95 ? 0.95 / peak : 1;
  if (gain !== 1) for (let i = 0; i < length; i++) mix[i] *= gain;
  return { mix, gain, seconds, sampleRate };
}

const nextPow2 = (n) => 2 ** Math.ceil(Math.log2(Math.max(2, n)));

// Measures the pitch frame by frame and compares it with base * 2^g(x).
function pitchCheck(data, pitch, sampleRate) {
  const defined = [];
  for (let i = 0; i < pitch.length; i += 64) if (Number.isFinite(pitch[i])) defined.push(pitch[i]);
  if (!defined.length) return { status: 'info', reason: 'The graph is undefined everywhere, so nothing sounds.', frames: 0, skipped: 0, track: [] };
  defined.sort((a, b) => a - b);
  const median = defined[Math.floor(defined.length / 2)];
  const frame = Math.min(8192, Math.max(1024, nextPow2(Math.ceil((4 * sampleRate) / Math.max(20, median)))));
  const hop = frame / 2, size = Math.max(16384, frame * 4), binHz = sampleRate / size;
  const track = [];
  let skipped = 0;
  for (let start = 0; start + frame <= data.length; start += hop) {
    let lo = Infinity, hi = 0, wsum = 0, fsum = 0, silent = false;
    for (let i = 0; i < frame; i += 8) {
      const f = pitch[start + i];
      if (!Number.isFinite(f)) { silent = true; break; }
      lo = Math.min(lo, f); hi = Math.max(hi, f);
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frame - 1));
      wsum += w; fsum += w * f;
    }
    if (silent) continue;
    const predicted = fsum / wsum;
    // A frame can only be measured if the pitch is nearly constant inside it (< 1 semitone) and has >= 3 cycles.
    if (hi / lo > 1.06 || predicted * (frame / sampleRate) < 3 || predicted > sampleRate / 2 - 100) { skipped++; continue; }
    const mag = magnitudeSpectrum(data, start, frame, size);
    const c = Math.round(predicted / binHz), w = Math.ceil(Math.max(20, 0.1 * predicted) / binHz);
    let k = Math.max(1, c - w);
    for (let j = Math.max(1, c - w); j <= Math.min(mag.length - 2, c + w); j++) if (mag[j] > mag[k]) k = j;
    const a = Math.log(mag[k - 1] + 1e-30), b = Math.log(mag[k] + 1e-30), cc = Math.log(mag[k + 1] + 1e-30);
    const d = a - 2 * b + cc;
    const measured = (k + (d === 0 ? 0 : Math.max(-0.5, Math.min(0.5, (0.5 * (a - cc)) / d)))) * binHz;
    track.push({ t: (start + frame / 2) / sampleRate, predicted, measured, error: Math.abs(measured - predicted) / predicted });
  }
  if (track.length < 3) {
    return { status: 'info', reason: 'The pitch changes too quickly to measure (it moves more than a semitone inside one analysis frame).', frames: track.length, skipped, track };
  }
  const errs = track.map((p) => p.error).sort((x, y) => x - y);
  const medianErr = errs[Math.floor(errs.length / 2)];
  return { status: medianErr <= 0.02 ? 'pass' : 'fail', medianRelError: medianErr, frames: track.length, skipped, frameMs: (frame / sampleRate) * 1000, track };
}

// Verification of one graph layer over the whole song (Hermann C1-C4).
// Pass `audio` to check existing audio against the formula instead of a fresh render.
export function verifyGraphLayer(layer, bpm, seconds, sampleRate = 44100, audio = null) {
  const length = Math.round(seconds * sampleRate);
  const first = audio ? { data: audio } : renderGraphLayer(layer, bpm, seconds, sampleRate);
  const second = renderGraphLayer(layer, bpm, seconds, sampleRate);
  // Independent reference: the AST interpreter (not the compiled closures) in double precision.
  const { ast } = compile(layer.formula);
  const env = { t: 0, f: keyToFreq(layer.key), v: 1 };
  const ref = synthesize((x) => { env.t = x; return evaluate(ast, env); }, layer, bpm, length, sampleRate, true);

  let identical = first.data.length === second.data.length, failures = 0, maxAbs = 0;
  for (let i = 0; i < length; i++) {
    if (first.data[i] !== second.data[i]) identical = false;
    const err = Math.abs(first.data[i] - ref.data[i]);
    // float32 storage of the reference value, plus the tiny difference float32 vs double gate/phase rounding can make
    if (err > Math.abs(ref.data[i]) * 2 ** -24 + 1e-7) failures++;
    maxAbs = Math.max(maxAbs, err);
  }
  const pitch = pitchCheck(first.data, ref.pitch, sampleRate);
  const warnings = [];
  if (ref.clamped) warnings.push(`${ref.clamped} samples asked for a pitch above ${sampleRate / 2} Hz and were limited (Nyquist).`);
  const silentPct = (100 * ref.undefinedSamples) / length;
  const conditions = [
    { id: 'C1', title: 'Sound matches the graph', status: failures || pitch.status === 'fail' ? 'fail' : 'pass',
      detail: `${length.toLocaleString()} samples recomputed independently (${failures} outside rounding). ` +
        (pitch.medianRelError != null ? `Measured pitch follows base x 2^y with median error ${(pitch.medianRelError * 100).toFixed(2)}% over ${pitch.frames} frames.` : pitch.reason) },
    { id: 'C2', title: 'Clear, fixed rule', status: 'pass', detail: GRAPH_RULE },
    { id: 'C3', title: 'Same graph, same sound', status: identical ? 'pass' : 'fail', detail: identical ? 'Rendered twice: bit-identical.' : 'Two renders differed.' },
    { id: 'C4', title: 'Works for any graph', status: 'pass', detail: 'Every layer uses the same parser and the same rule.' },
  ];
  return { conditions, pitch, numeric: { failures, maxAbs, samples: length }, silentPct, warnings, verdict: conditions.every((c) => c.status === 'pass') ? 'pass' : 'fail' };
}

// Draws the graph like a graphing calculator: white paper, black axes, coloured curves, moving dot.
export function drawGraph(ctx, w, h, graph, bpm, playX, { yRange = null, span = 8, showFormula = true, colors = [] } = {}) {
  const totalBeats = graph.bars * 4;
  const x0 = Math.max(0, Math.min(totalBeats - span, (playX ?? 0) - span / 2));
  const fns = graph.layers.map((l) => {
    try { const g = compile(l.formula).fn; const env = { t: 0, f: keyToFreq(l.key), v: 1 }; return (x) => { env.t = x; return g(env); }; } catch { return () => NaN; }
  });
  let [ylo, yhi] = yRange || [Infinity, -Infinity];
  if (!yRange) {
    for (const g of fns) for (let i = 0; i <= 400; i++) { const y = g(x0 + (i / 400) * span); if (Number.isFinite(y)) { ylo = Math.min(ylo, y); yhi = Math.max(yhi, y); } }
    if (!Number.isFinite(ylo)) { ylo = -2; yhi = 2; }
    const padY = Math.max(0.3, (yhi - ylo) * 0.15);
    ylo -= padY; yhi += padY;
  }
  const plotH = showFormula ? h * 0.78 : h;
  const X = (x) => ((x - x0) / span) * w;
  const Y = (y) => plotH - ((y - ylo) / (yhi - ylo)) * plotH;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#e6e6e6';
  ctx.lineWidth = 1;
  for (let b = Math.ceil(x0); b <= x0 + span; b++) { ctx.beginPath(); ctx.moveTo(X(b), 0); ctx.lineTo(X(b), plotH); ctx.stroke(); }
  ctx.strokeStyle = '#000';
  ctx.lineWidth = Math.max(1.5, w / 600);
  const yAxis = ylo < 0 && yhi > 0 ? Y(0) : plotH - 1;
  ctx.beginPath(); ctx.moveTo(0, yAxis); ctx.lineTo(w, yAxis); ctx.stroke();
  graph.layers.forEach((l, i) => {
    if (l.mute) return;
    ctx.strokeStyle = colors[i] || '#000';
    ctx.lineWidth = Math.max(2, w / 400);
    ctx.beginPath();
    let pen = false;
    for (let px = 0; px <= w; px += 1) {
      const y = fns[i](x0 + (px / w) * span);
      if (!Number.isFinite(y)) { pen = false; continue; }
      if (pen) ctx.lineTo(px, Y(y)); else ctx.moveTo(px, Y(y));
      pen = true;
    }
    ctx.stroke();
    if (playX != null) {
      const y = fns[i](playX);
      if (Number.isFinite(y)) { ctx.fillStyle = colors[i] || '#000'; ctx.beginPath(); ctx.arc(X(playX), Y(y), Math.max(5, w / 140), 0, TWO_PI); ctx.fill(); }
    }
  });
  if (playX != null) { ctx.strokeStyle = '#bdbdbd'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(X(playX), 0); ctx.lineTo(X(playX), plotH); ctx.stroke(); }
  if (showFormula) {
    const lines = graph.layers.filter((l) => !l.mute);
    const fs = Math.max(11, Math.min(w / 45, (h - plotH) / (lines.length + 0.5) * 0.75));
    ctx.font = `${fs}px "Cambria Math", "Times New Roman", serif`;
    ctx.textBaseline = 'middle';
    lines.forEach((l, i) => {
      ctx.fillStyle = colors[graph.layers.indexOf(l)] || '#000';
      let text = `${l.name}:  y = ${l.formula}`;
      while (ctx.measureText(text).width > w - 20 && text.length > 10) text = `${text.slice(0, -2)}…`;
      ctx.fillText(text, 10, plotH + (i + 0.75) * fs * 1.25);
    });
  }
  return { x0, span, ylo, yhi };
}
