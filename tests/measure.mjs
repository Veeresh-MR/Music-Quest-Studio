// Collects the measurements reported in the research paper and writes docs/results.json.
// Run: node tests/measure.mjs   (single thread, Node.js; numbers depend on the machine)
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { LIBRARY, renderFormula } from '../src/js/synth.js';
import { verifyFormula } from '../src/js/verify.js';
import { verifyGraphLayer, renderGraphLayer, EXAMPLE } from '../src/js/graph.js';

const SR = 44100;
const results = { generated: new Date().toISOString(), machine: `${os.cpus()[0].model.trim()}, Node.js ${process.version}`, sampleRate: SR };

// 1. Known-answer tones: predicted frequency vs FFT measurement (1 s, sine).
results.knownTones = [27.5, 55, 110, 220, 440, 1000, 4000, 10000, 18000].map((hz) => {
  const r = verifyFormula(`0.5*sin(tau*${hz}*t)`, { duration: 1 });
  const m = r.found[0];
  return { hz, measured: m.measured, absError: m.error, relError: m.error / hz, status: m.status, numericFailures: r.numeric.failures };
});

// 2. Every built-in instrument at A3 (220 Hz).
results.instruments = LIBRARY.map((item) => {
  const duration = item.mode === 'oneshot' ? item.length : 1.5;
  const t0 = performance.now();
  const r = verifyFormula(item.formula, { f: 220, duration });
  const ms = performance.now() - t0;
  const measured = r.found.filter((f) => f.status === 'pass');
  return {
    name: item.name, group: item.group, mode: item.mode, samples: r.numeric.samples,
    numericFailures: r.numeric.failures, maxAbs: r.numeric.maxAbs, identical: r.identical,
    tonesPredicted: r.found.length, tonesMeasured: measured.length,
    maxToneError: measured.length ? Math.max(...measured.map((f) => f.error)) : null,
    peaksChecked: r.explained?.peaks.length ?? 0, peaksExplained: r.explained ? r.explained.peaks.filter((p) => p.status === 'pass').length : 0,
    sweep: r.sweep ? { status: r.sweep.status, medianRelError: r.sweep.medianRelError ?? null } : null,
    peak: r.peak, verdict: r.verdict, verifyMs: ms,
  };
});

// 3. Negative tests: audio that does NOT match its formula must be rejected.
const audio = (src, d = 1) => renderFormula(src, { duration: d }).data;
const oneSample = audio('sin(tau*440*t)').map((x, i) => (i === 1000 ? x + 0.01 : x));
const gl = (formula) => ({ name: 'g', formula, key: 69, volume: 0.6, wave: 'sine', mute: false });
results.negative = [
  { case: '450 Hz tone checked as sin(tau*440*t)', rejected: verifyFormula('sin(tau*440*t)', { audio: audio('sin(tau*450*t)') }).verdict === 'fail' },
  { case: '441 Hz tone checked as sin(tau*440*t)', rejected: verifyFormula('sin(tau*440*t)', { audio: audio('sin(tau*441*t)') }).verdict === 'fail' },
  { case: 'one sample changed by 0.01 (of 44,100)', rejected: verifyFormula('sin(tau*440*t)', { audio: oneSample }).verdict === 'fail' },
  { case: 'FM ratio 1:3 checked as 1:3.5', rejected: verifyFormula('sin(tau*440*t + 2*sin(tau*1540*t))', { audio: audio('sin(tau*440*t + 2*sin(tau*1320*t))') }).verdict === 'fail' },
  { case: 'graph one semitone off (y = 0 vs y = 1/12)', rejected: verifyGraphLayer(gl('1/12'), 120, 2, SR, renderGraphLayer(gl('0'), 120, 2, SR).data).verdict === 'fail' },
  { case: 'correct audio (control, must be accepted)', rejected: verifyFormula('sin(tau*440*t)', { audio: audio('sin(tau*440*t)') }).verdict === 'fail' },
];

// 4. Graph mode: the example song's layers over the whole song.
const seconds = (EXAMPLE.bars * 4 * 60) / EXAMPLE.bpm;
results.graph = EXAMPLE.layers.map((l) => {
  const r = verifyGraphLayer({ ...l, mute: false }, EXAMPLE.bpm, seconds);
  return { name: l.name, samples: r.numeric.samples, numericFailures: r.numeric.failures, pitchStatus: r.pitch.status, pitchFrames: r.pitch.frames, pitchSkipped: r.pitch.skipped, medianRelError: r.pitch.medianRelError ?? null, silentPct: r.silentPct, verdict: r.verdict };
});

// 5. Rendering speed (single thread).
results.speed = ['Kick', 'Piano', 'Strings', 'Cello', 'Choir Aah'].map((name) => {
  const f = LIBRARY.find((i) => i.name === name).formula;
  renderFormula(f, { f: 220, duration: 0.2 });
  const t0 = performance.now();
  renderFormula(f, { f: 221, duration: 10 });
  const ms = performance.now() - t0;
  return { name, msPer10s: ms, realtimeFactor: 10000 / ms };
});

writeFileSync(new URL('../docs/results.json', import.meta.url), JSON.stringify(results, null, 1));
const inst = results.instruments;
console.log(`tones ${results.knownTones.filter((t) => t.status === 'pass').length}/${results.knownTones.length} | instruments ${inst.filter((i) => i.verdict === 'pass').length}/${inst.length} pass | negatives rejected ${results.negative.filter((n) => n.rejected).length}/${results.negative.length - 1} + control accepted ${!results.negative.at(-1).rejected} | graph ${results.graph.map((g) => `${g.name}:${g.verdict}`).join(' ')}`);
console.log('max known-tone error (Hz):', Math.max(...results.knownTones.map((t) => t.absError)).toFixed(4), '| speed x realtime:', results.speed.map((s) => `${s.name} ${s.realtimeFactor.toFixed(0)}x`).join(', '));
