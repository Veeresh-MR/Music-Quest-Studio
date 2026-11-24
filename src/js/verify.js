// Proof that a sound is correct for its formula.
// 1. Numeric check    - an independent interpreter recomputes every sample and compares (float32 precision).
// 2. Frequency checks - frequencies predicted from the formula's own phase terms are compared with an FFT
//                       measurement (Cooley & Tukey 1965), in both directions:
//                       predicted -> found in the audio, and strongest audio peaks -> explained by the formula
//                       (harmonics, FM sidebands per Chowning 1973, aliasing per Stilson & Smith 1996).
//                       A changing pitch (glide) is tracked frame by frame with a short-time FFT.
// 3. Reproducibility  - rendering twice must give bit-identical samples (Hermann 2008, C3).
import { compile, evaluate, dependsOn, walk, OSCILLATORS, DISCONTINUOUS } from './formula.js';
import { renderFormula, RENDER_RULE } from './synth.js';

const LFO_LIMIT = 20; // modulators slower than this are vibrato/tremolo, not separate tones

// In-place iterative radix-2 FFT. re/im lengths must be a power of two.
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

const nextPow2 = (n) => 2 ** Math.ceil(Math.log2(Math.max(2, n)));
const hann = (i, count) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, count - 1));

// Hann-windowed magnitude spectrum of data[start .. start+count), zero-padded to `size`.
export function magnitudeSpectrum(data, start, count, size) {
  const re = new Float64Array(size), im = new Float64Array(size);
  for (let i = 0; i < count; i++) re[i] = (data[start + i] || 0) * hann(i, count);
  fft(re, im);
  const mag = new Float64Array(size / 2);
  for (let k = 0; k < size / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
  return mag;
}

// Peak position refined by fitting a parabola to the log magnitude of 3 bins.
function refinedPeak(mag, lo, hi) {
  lo = Math.max(1, lo);
  hi = Math.min(hi, mag.length - 2);
  let k = lo;
  for (let i = lo; i <= hi; i++) if (mag[i] > mag[k]) k = i;
  const a = Math.log(mag[k - 1] + 1e-30), b = Math.log(mag[k] + 1e-30), c = Math.log(mag[k + 1] + 1e-30);
  const denom = a - 2 * b + c;
  const delta = denom === 0 ? 0 : (0.5 * (a - c)) / denom;
  return { bin: k + Math.max(-0.5, Math.min(0.5, delta)), mag: mag[k] };
}

function containsDiscontinuity(node) {
  let found = false;
  walk(node, (n) => {
    if ((n.type === 'call' && DISCONTINUOUS.has(n.name)) || (n.type === 'bin' && n.op === '%')) found = true;
  });
  return found;
}

function oscillatorsIn(node, insidePhase, out) {
  if (node.type === 'call' && OSCILLATORS[node.name]) {
    if (dependsOn(node.args[0], 't')) out.push({ node, insidePhase });
    node.args.forEach((a) => oscillatorsIn(a, true, out));
  } else if (node.type === 'neg') oscillatorsIn(node.a, insidePhase, out);
  else if (node.type === 'bin') { oscillatorsIn(node.a, insidePhase, out); oscillatorsIn(node.b, insidePhase, out); }
  else if (node.type === 'call') node.args.forEach((a) => oscillatorsIn(a, insidePhase, out));
  return out;
}

// True when two audio-rate oscillators are multiplied (ring modulation creates sum/difference tones).
function hasAudioRateProduct(ast, env, duration) {
  let found = false;
  walk(ast, (n) => {
    if (found || n.type !== 'bin' || n.op !== '*') return;
    const fast = (side) => oscillatorsIn(side, false, []).some(({ node }) => meanFrequency(node, env, duration) >= LFO_LIMIT);
    if (fast(n.a) && fast(n.b)) found = true;
  });
  return found;
}

// Instantaneous frequency (Hz) of an oscillator at time t: derivative of its phase.
function instFrequency(osc, env, t) {
  const h = 1e-5;
  const unit = OSCILLATORS[osc.name] === 'radians' ? 2 * Math.PI : 1;
  const t1 = Math.max(0, t - h), t2 = t + h;
  const p1 = evaluate(osc.args[0], { ...env, t: t1 });
  const p2 = evaluate(osc.args[0], { ...env, t: t2 });
  return (p2 - p1) / ((t2 - t1) * unit);
}

// Exact average frequency over the sound: total phase change / total time (unbiased even when
// a modulation depth fades out, unlike averaging a few instantaneous values).
function meanFrequency(osc, env, duration) {
  const unit = OSCILLATORS[osc.name] === 'radians' ? 2 * Math.PI : 1;
  const p0 = evaluate(osc.args[0], { ...env, t: 0 });
  const p1 = evaluate(osc.args[0], { ...env, t: duration });
  return Math.abs((p1 - p0) / (duration * unit));
}

// Classifies one audible oscillator: steady tone, FM tone, glide, or unpredictable.
function describeOscillator(osc, env, duration) {
  const unsure = containsDiscontinuity(osc.args[0]);
  const count = 64;
  const freqs = [];
  for (let i = 0; i < count; i++) freqs.push(instFrequency(osc, env, (duration * (i + 0.5)) / count));
  const mean = meanFrequency(osc, env, duration) * Math.sign(freqs.reduce((s, x) => s + x, 0) || 1);
  const spread = Math.max(...freqs.map((x) => Math.abs(x - mean)));
  const modulators = oscillatorsIn(osc.args[0], true, [])
    .map(({ node }) => ({ node, freq: meanFrequency(node, env, duration) }));
  const audioMods = modulators.filter((m) => m.freq >= LFO_LIMIT);
  let kind;
  if (unsure) kind = 'unsure';
  else if (spread <= Math.max(0.005 * Math.abs(mean), 0.05)) kind = 'steady';
  else if (audioMods.length) kind = 'fm';
  else if (modulators.length && spread <= 0.03 * Math.abs(mean)) kind = 'steady'; // vibrato only
  else kind = 'glide';
  return {
    osc, kind, freq: Math.abs(mean), spread, start: Math.abs(freqs[0]), end: Math.abs(freqs[count - 1]),
    modFreqs: audioMods.map((m) => m.freq),
    lfoFreqs: modulators.filter((m) => m.freq < LFO_LIMIT && m.freq > 0.05).map((m) => m.freq),
  };
}

function fnv1a(floats) {
  const bytes = new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

function numericCheck(ast, data, env, sampleRate) {
  let maxAbs = 0, maxRel = 0, worst = 0, failures = 0;
  const e = { ...env };
  for (let n = 0; n < data.length; n++) {
    e.t = n / sampleRate;
    let ref = evaluate(ast, e);
    if (!Number.isFinite(ref)) ref = 0;
    const err = Math.abs(data[n] - ref);
    // A float32 sample can differ from the exact double value by at most half a unit in the last place.
    const allowed = Math.abs(ref) * 2 ** -24 + 1e-38;
    if (err > allowed * 1.0001) failures++;
    if (err > maxAbs) { maxAbs = err; worst = n; }
    if (ref !== 0) maxRel = Math.max(maxRel, err / Math.abs(ref));
  }
  return { pass: failures === 0, maxAbs, maxRel, failures, worstSample: worst, samples: data.length };
}

// Folds a frequency into 0..nyquist the way sampling does (aliasing).
function fold(freq, sampleRate) {
  const m = ((freq % sampleRate) + sampleRate) % sampleRate;
  return m > sampleRate / 2 ? sampleRate - m : m;
}

// Switching rates (Hz) of time-based gates outside oscillator phases, e.g. frac(2*t) switches 2 times per second.
// Switching a tone on and off adds sidebands at tone +/- k * rate (product of a tone and a periodic gate).
function gateRates(ast, env, duration) {
  const rates = new Set();
  const slope = (node) => Math.abs((evaluate(node, { ...env, t: duration }) - evaluate(node, { ...env, t: 0 })) / duration);
  const visit = (node) => {
    if (node.type === 'call' && OSCILLATORS[node.name]) return; // phases are handled as oscillators
    if (node.type === 'call' && ['frac', 'floor', 'ceil', 'round'].includes(node.name) && dependsOn(node.args[0], 't')) rates.add(slope(node.args[0]));
    if (node.type === 'call' && node.name === 'mod' && dependsOn(node.args[0], 't') && !dependsOn(node.args[1], 't')) rates.add(slope(node.args[0]) / Math.abs(evaluate(node.args[1], env)));
    if (node.type === 'bin' && node.op === '%' && dependsOn(node.a, 't') && !dependsOn(node.b, 't')) rates.add(slope(node.a) / Math.abs(evaluate(node.b, env)));
    if (node.type === 'neg') visit(node.a);
    else if (node.type === 'bin') { visit(node.a); visit(node.b); }
    else if (node.type === 'call') node.args.forEach(visit);
  };
  visit(ast);
  return [...rates].filter((r) => Number.isFinite(r) && r > 1 / duration);
}

// Every frequency the formula can produce: harmonics of each tone (with aliasing for sharp waves),
// FM sidebands n*carrier + k*modulator, and switching sidebands +/- j*gateRate.
function predictedLines(tones, sampleRate, gateRate = 0) {
  const lines = [];
  for (const o of tones) {
    const sharp = o.osc.name === 'saw' || o.osc.name === 'sqr' || o.osc.name === 'tri';
    const maxN = sharp ? 64 : 8;
    // FM sidebands sit at n*carrier + k*modulator; a slow vibrato makes the same pattern close to each harmonic.
    const mods = o.kind === 'fm' ? o.modFreqs : o.lfoFreqs;
    for (let n = 1; n <= maxN; n++) {
      const ks = !mods.length ? [0, 0] : o.kind === 'fm' ? [-12, 12] : [-4, 4];
      for (let k = ks[0]; k <= ks[1]; k++) {
        const raw = Math.abs(n * o.freq + k * (mods[0] || 0));
        if (raw === 0) continue;
        const f = raw > sampleRate / 2 ? fold(raw, sampleRate) : raw;
        const label = `${n > 1 ? n + '×' : ''}${o.freq.toFixed(1)} Hz${k ? ` ${k > 0 ? '+' : '−'} ${Math.abs(k)}×${mods[0].toFixed(1)} Hz` : ''}${raw > sampleRate / 2 ? ' (aliased)' : ''}`;
        // vibrato moves harmonic n by n times as much as the fundamental
        lines.push({ freq: f, label, extra: o.kind === 'steady' ? n * o.spread : 0 });
        for (let j = 1; gateRate && j <= 20; j++) {
          for (const sgn of [1, -1]) {
            const g = Math.abs(f + sgn * j * gateRate);
            if (g > 0) lines.push({ freq: g, label: `${label} ${sgn > 0 ? '+' : '−'} ${j}×${gateRate.toFixed(2)} Hz (on/off switching)`, extra: 0 });
          }
        }
      }
    }
  }
  return lines;
}

function strongestPeaks(mag, binHz, maxCount, floorDb) {
  let globalMax = 0;
  for (let k = 1; k < mag.length; k++) globalMax = Math.max(globalMax, mag[k]);
  const floor = globalMax * 10 ** (floorDb / 20);
  const peaks = [];
  const guard = Math.max(3, Math.round(3 / binHz));
  for (let k = guard; k < mag.length - guard; k++) {
    if (mag[k] < floor || (20 / binHz) > k) continue;
    let isMax = true;
    for (let j = 1; j <= guard && isMax; j++) if (mag[k - j] > mag[k] || mag[k + j] >= mag[k]) isMax = false;
    if (isMax) peaks.push(k);
  }
  return peaks
    .sort((a, b) => mag[b] - mag[a])
    .slice(0, maxCount)
    .map((k) => {
      const p = refinedPeak(mag, k - 1, k + 1);
      return { freq: p.bin * binHz, levelDb: 20 * Math.log10(p.mag / globalMax) };
    });
}

function spectrumChecks(tones, data, sampleRate, allowExplain, gateRate = 0) {
  const count = Math.min(data.length, 131072);
  const size = Math.max(16384, nextPow2(count));
  const mag = magnitudeSpectrum(data, 0, count, size);
  const binHz = sampleRate / size;
  const duration = count / sampleRate;
  const resolution = 2 / duration; // Hann main lobe: tones closer than this merge into one peak
  let globalMax = 0;
  for (let k = 1; k < mag.length; k++) globalMax = Math.max(globalMax, mag[k]);

  // Direction 1: each predicted tone is present at the predicted frequency.
  const steady = tones.filter((o) => o.kind === 'steady' || o.kind === 'fm');
  const unique = [];
  for (const o of steady) if (!unique.some((u) => Math.abs(u.freq - o.freq) < 0.01)) unique.push(o);
  const found = unique.map((o) => {
    const freq = o.freq;
    const base = { predicted: freq, kind: o.kind, modFreqs: o.modFreqs };
    if (freq >= sampleRate / 2) {
      return { ...base, measured: null, status: 'fail', reason: `Above the Nyquist limit (${sampleRate / 2} Hz), so it cannot be represented and aliases.` };
    }
    const neighbour = unique.find((u) => u !== o && Math.abs(u.freq - freq) < resolution);
    if (neighbour) {
      return { ...base, measured: null, status: 'info', reason: `Closer than ${resolution.toFixed(2)} Hz to another tone (${neighbour.freq.toFixed(2)} Hz). A ${duration.toFixed(1)} s sound cannot separate them; use a longer duration to verify.` };
    }
    if (o.kind === 'fm') {
      return { ...base, measured: null, status: 'info', reason: 'FM carrier: checked through its sidebands below.' };
    }
    const width = Math.max(4, Math.ceil((0.004 * freq + o.spread) / binHz));
    const center = Math.round(freq / binHz);
    const peak = refinedPeak(mag, center - width, center + width);
    const measured = peak.bin * binHz;
    const levelDb = 20 * Math.log10((peak.mag + 1e-30) / (globalMax + 1e-30));
    if (levelDb < -60) return { ...base, measured: null, status: 'info', reason: 'Too quiet in the mix to measure (below -60 dB).' };
    // a switched tone's peak can sit on its nearest switching sideband, up to one gate rate away
    const tolerance = Math.max(binHz, 0.002 * freq) + o.spread + gateRate;
    const error = Math.abs(measured - freq);
    return { ...base, measured, error, levelDb, tolerance, status: error <= tolerance ? 'pass' : 'fail' };
  });

  // Direction 2: the strongest peaks in the audio are all explained by the formula.
  let explained = null, gateNote = null;
  if (gateRate && gateRate < resolution) {
    gateNote = `Tones are switched on and off ${gateRate.toFixed(2)} times per second, which adds sidebands every ${gateRate.toFixed(2)} Hz. ` +
      `A ${duration.toFixed(1)} s analysis can only separate frequencies ${resolution.toFixed(2)} Hz apart, so the "every peak explained" check needs at least ${(2 / gateRate).toFixed(1)} s. Increase "Analyse" to check it.`;
  } else if (allowExplain && tones.length) {
    const lines = predictedLines(tones, sampleRate, gateRate);
    const peaks = strongestPeaks(mag, binHz, 8, -30).map((p) => {
      let best = null;
      for (const l of lines) {
        const d = Math.abs(l.freq - p.freq);
        if (!best || d < best.d) best = { d, line: l };
      }
      const tol = Math.max(2 * binHz, 0.004 * p.freq, resolution / 2) + (best?.line.extra || 0);
      return { ...p, explainedBy: best && best.d <= tol ? best.line.label : null, status: best && best.d <= tol ? 'pass' : 'fail' };
    });
    explained = { peaks, status: peaks.every((p) => p.status === 'pass') ? 'pass' : 'fail' };
  }
  return { found, explained, mag, binHz, resolution, gateNote };
}

function sweepCheck(item, env, data, sampleRate) {
  // Window long enough for at least 4 cycles of the lowest pitch (low notes need longer frames).
  const lowest = Math.max(20, Math.min(item.start, item.end, item.freq));
  const frame = Math.min(8192, Math.max(1024, nextPow2(Math.ceil((4 * sampleRate) / lowest))));
  const hop = frame / 4, size = Math.max(16384, frame * 4);
  const binHz = sampleRate / size;
  const frameSec = frame / sampleRate;
  let peakRms = 0;
  const frames = [];
  for (let start = 0; start + frame <= data.length; start += hop) {
    let s = 0;
    for (let i = 0; i < frame; i++) s += data[start + i] ** 2;
    const rms = Math.sqrt(s / frame);
    peakRms = Math.max(peakRms, rms);
    frames.push({ start, rms });
  }
  const track = [];
  let skipped = 0;
  for (const { start, rms } of frames) {
    if (rms < 0.05 * peakRms) continue;
    // Prediction = window-weighted mean of the instantaneous frequency over the frame,
    // which is what a windowed FFT of a gliding tone measures.
    let wsum = 0, fsum = 0;
    for (let i = 0; i < 16; i++) {
      const w = hann(i, 16);
      fsum += w * Math.abs(instFrequency(item.osc, env, (start + ((i + 0.5) / 16) * frame) / sampleRate));
      wsum += w;
    }
    const predicted = fsum / wsum;
    if (predicted >= sampleRate / 2 || predicted * frameSec < 3) { skipped++; continue; } // < 3 cycles: not measurable
    const mag = magnitudeSpectrum(data, start, frame, size);
    const center = Math.round(predicted / binHz);
    const width = Math.ceil(Math.max(30, 0.15 * predicted) / binHz);
    const measured = refinedPeak(mag, center - width, center + width).bin * binHz;
    track.push({ t: (start + frame / 2) / sampleRate, predicted, measured, error: Math.abs(measured - predicted) });
  }
  if (!track.length) return { status: 'info', reason: 'Sound too short, quiet or low to track its pitch.', track, skipped };
  const errors = track.map((p) => p.error / p.predicted).sort((a, b) => a - b);
  const median = errors[Math.floor(errors.length / 2)];
  return { status: median <= 0.03 ? 'pass' : 'fail', medianRelError: median, track, skipped };
}

// Full verification of one formula at one note. Returns everything the Proof panel shows.
// Pass `audio` (Float32Array) to check existing audio against the formula instead of a fresh render.
export function verifyFormula(source, { f = 440, v = 1, duration = 1, sampleRate = 44100, audio = null } = {}) {
  const { ast } = compile(source);
  const env = { t: 0, f, v };
  if (audio) duration = audio.length / sampleRate;
  const first = audio ? { data: audio, invalid: 0 } : renderFormula(source, { f, v, duration, sampleRate });
  const second = renderFormula(source, { f, v, duration, sampleRate });
  const data = first.data;

  let identical = first.data.length === second.data.length;
  for (let i = 0; identical && i < data.length; i++) if (first.data[i] !== second.data[i]) identical = false;
  const hash = fnv1a(data);
  const numeric = numericCheck(ast, data, env, sampleRate);

  let peak = 0, clipped = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]);
    peak = Math.max(peak, a);
    if (a > 1) clipped++;
  }

  const tones = oscillatorsIn(ast, false, [])
    .filter((o) => !o.insidePhase)
    .map((o) => describeOscillator(o.node, env, duration))
    .filter((o) => o.freq >= LFO_LIMIT || o.kind === 'glide'); // slow oscillators are envelopes/LFOs
  const glides = tones.filter((o) => o.kind === 'glide');
  const unsure = tones.filter((o) => o.kind === 'unsure');

  let usesNoise = false;
  walk(ast, (n) => { if (n.type === 'call' && n.name === 'noise') usesNoise = true; });
  const ringMod = hasAudioRateProduct(ast, env, duration);
  const allowExplain = !usesNoise && !ringMod && !glides.length && !unsure.length;
  const gates = gateRates(ast, env, duration);
  const gateRate = gates.length ? Math.min(...gates) : 0;
  const spectrum = spectrumChecks(tones.filter((o) => o.kind !== 'glide' && o.kind !== 'unsure'), data, sampleRate, allowExplain, gateRate);

  let sweep = null;
  if (glides.length === 1 && tones.length === 1) {
    sweep = { ...sweepCheck(glides[0], env, data, sampleRate), start: glides[0].start, end: glides[0].end };
  } else if (glides.length) {
    sweep = { status: 'info', reason: 'A gliding tone is mixed with other tones, so its pitch track cannot be isolated.', track: [] };
  }

  const notes = [];
  if (usesNoise) notes.push('Contains noise, so the "every peak explained" check is skipped (noise has no fixed pitch).');
  if (ringMod) notes.push('Two audio-rate tones are multiplied (ring modulation), so sum/difference tones are not predicted.');
  if (spectrum.gateNote) notes.push(spectrum.gateNote);
  else if (gateRate) notes.push(`Tones are switched on and off ${gateRate.toFixed(2)} times per second; the resulting sidebands (tone ± k×${gateRate.toFixed(2)} Hz) are predicted and checked.`);

  const statuses = [
    ...spectrum.found.map((r) => r.status),
    spectrum.explained?.status,
    sweep?.status,
  ].filter(Boolean);
  const freqFail = statuses.includes('fail');
  const freqMeasured = statuses.some((s) => s === 'pass' || s === 'fail');

  const warnings = [];
  if (first.invalid) warnings.push(`${first.invalid} samples were not numbers (for example division by zero) and were set to 0.`);
  if (clipped) warnings.push(`${clipped} samples are louder than 1.0 and will be limited by the master limiter. Lower the volume in the formula.`);
  if (containsDiscontinuity(ast)) warnings.push('Uses sharp-edged functions (saw, sqr, mod, step, noise ...). Harmonics above half the sample rate fold back (aliasing, Stilson & Smith 1996).');
  if (unsure.length) warnings.push('Some tones have a jumping phase (noise or step inside the phase), so their pitch is not predicted.');

  const conditions = [
    {
      id: 'C1', title: 'Sound matches the formula',
      status: !numeric.pass || freqFail ? 'fail' : 'pass',
      detail: !numeric.pass
        ? `${numeric.failures} samples differ from the independent calculation.`
        : freqMeasured
          ? `All ${numeric.samples.toLocaleString()} samples match the independent calculation, and ${freqFail ? 'some frequency checks FAILED' : 'every measured frequency agrees with the formula'}.`
          : `All ${numeric.samples.toLocaleString()} samples match the independent calculation. ${tones.length
            ? `The pitch could not be measured: ${(sweep?.reason || spectrum.found.find((f) => f.reason)?.reason || 'see the frequency checks').replace(/\.$/, '')}.`
            : 'There is no tone with a pitch to measure (noise or envelope-only sound).'}`,
    },
    { id: 'C2', title: 'Clear, fixed rule', status: 'pass', detail: RENDER_RULE },
    {
      id: 'C3', title: 'Same formula, same sound',
      status: identical ? 'pass' : 'fail',
      detail: identical ? `Rendered twice: bit-identical (fingerprint ${hash}).` : 'Two renders differed.',
    },
    {
      id: 'C4', title: 'Works for any formula',
      status: 'pass',
      detail: 'Processed by the same general parser and renderer as every other sound; nothing is pre-recorded.',
    },
  ];

  return {
    source, f, v, duration, sampleRate, data, hash, identical, numeric, peak, clipped,
    found: spectrum.found, explained: spectrum.explained, resolution: spectrum.resolution,
    spectrum: spectrum.mag, binHz: spectrum.binHz, sweep, warnings, notes, conditions,
    verdict: conditions.every((c) => c.status === 'pass') ? 'pass' : 'fail',
  };
}
