// Engine tests: run with `npm test`.
import { parse, compile, FormulaError } from '../src/js/formula.js';
import { LIBRARY, renderFormula } from '../src/js/synth.js';
import { verifyFormula } from '../src/js/verify.js';
import { verifyGraphLayer, renderGraphLayer } from '../src/js/graph.js';

let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failed++; };
const val = (src, env = { t: 0.5, f: 440, v: 1 }) => compile(src).fn(env);

// Parser and math
ok(val('1 + 2*3') === 7, 'precedence');
ok(val('-2^2') === -4, 'unary minus binds weaker than power');
ok(val('2^3^2') === 512, 'power is right-associative');
ok(Math.abs(val('2pi') - 2 * Math.PI) < 1e-12, 'implicit multiplication');
ok(val('y = t*2') === 1, 'strips "y =" prefix');
ok(val('mod(-1, 3)') === 2 && val('-1 % 3') === 2, 'mod is always positive');
ok(val('x') === 0.5, 'x is an alias of t');
for (const bad of ['', 'sin()', 'foo(t)', 'alert(1)', 'window', 't +', '(t', 'constructor', '__proto__', 't; 1']) {
  let threw = false;
  try { parse(bad); } catch (e) { threw = e instanceof FormulaError; }
  ok(threw, `rejects unsafe/invalid input: ${JSON.stringify(bad)}`);
}

// Known-answer frequency tests
for (const [src, hz] of [['sin(tau*440*t)', 440], ['0.5*sin(2*pi*1000*t)', 1000], ['saw(220*t)*0.4', 220], ['sin(tau*f*t)', 261.6255653005986]]) {
  const r = verifyFormula(src, { f: 261.6255653005986, duration: 1 });
  const s = r.found[0];
  ok(r.verdict === 'pass' && s && Math.abs(s.measured - hz) < 0.7, `${src}: predicted ${hz.toFixed(2)} Hz, measured ${s?.measured?.toFixed(3)} Hz`);
}
const sweep = verifyFormula('sin(tau*(200*t + 150*t^2))', { duration: 1.5 });
ok(sweep.sweep?.status === 'pass', `chirp 200->650 Hz tracked, median error ${(sweep.sweep?.medianRelError * 100).toFixed(2)}%`);

const vib = verifyFormula('0.6*sin(tau*(110*t + 0.5*sin(tau*2*t)))', { duration: 1.5 });
ok(vib.sweep?.status === 'pass', `low vibrato tone (110 Hz +/- 6 Hz at 2 Hz) tracked, median error ${(vib.sweep?.medianRelError * 100).toFixed(2)}%`);
const bass = verifyFormula('sin(tau*(41.2*t + 3*(1-exp(-20*t))))', { duration: 1 });
ok(bass.sweep?.status === 'pass', `deep glide (101 -> 41 Hz) tracked, median error ${(bass.sweep?.medianRelError * 100).toFixed(2)}%`);
const fmWrong = verifyFormula('sin(tau*440*t + 2*sin(tau*1540*t))', { audio: renderFormula('sin(tau*440*t + 2*sin(tau*1320*t))', { duration: 1 }).data });
ok(fmWrong.verdict === 'fail', 'detects FM audio made with a different modulator ratio');

// A deliberately wrong claim must fail: render one formula, verify against another.
const tampered = verifyFormula('sin(tau*440*t)', { audio: renderFormula('sin(tau*450*t)', { duration: 1 }).data });
ok(tampered.verdict === 'fail' && tampered.conditions[0].status === 'fail', 'detects audio that does not match its formula (450 Hz claimed as 440 Hz)');
const quiet = renderFormula('sin(tau*440*t)', { duration: 1 }).data.map((x, i) => (i === 1000 ? x + 0.01 : x));
ok(verifyFormula('sin(tau*440*t)', { audio: quiet }).numeric.failures === 1, 'detects a single altered sample');

// Notes switched on/off by frac(): sidebands are predicted, and a wrong note is still caught
const ARP = 'if(0.25-frac(2*x),sin(2*pi*261.63*x),0)+if(0.5-frac(2*x),sin(2*pi*329.63*x),0)+if(0.75-frac(2*x),sin(2*pi*392*x),0)+if(frac(2*x)-0.75,0,sin(2*pi*523.25*x))';
ok(verifyFormula(ARP, { duration: 1.5 }).verdict === 'pass', 'switched arpeggio (user formula) passes with switching sidebands predicted');
ok(verifyFormula(ARP, { audio: renderFormula(ARP.replace('392', '400'), { duration: 1.5 }).data }).verdict === 'fail', 'switched arpeggio with one wrong note (400 Hz instead of 392 Hz) is rejected');

// Graph mode (graph heard as pitch)
const GL = (formula, extra = {}) => ({ name: 'g', formula, key: 69, volume: 0.6, wave: 'sine', mute: false, ...extra });
for (const [label, layer, bpm, sec] of [['graph constant y=0 -> 440 Hz', GL('0'), 120, 2], ['graph glide y=x/4', GL('x/4'), 120, 4], ['graph stepped melody', GL('round(12*mod(3*floor(2*x), 7)/7)/12', { wave: 'warm' }), 120, 4]]) {
  const r = verifyGraphLayer(layer, bpm, sec);
  ok(r.verdict === 'pass' && r.pitch.status === 'pass', `${label}: pitch error ${(r.pitch.medianRelError * 100).toFixed(3)}% over ${r.pitch.frames} frames`);
}
const kick = verifyGraphLayer(GL('3.5*exp(-5*frac(x)) - 3.2', { key: 57 }), 140, 4);
ok(kick.verdict === 'pass' && kick.numeric.failures === 0, 'graph kick from the video: samples verified, fast pitch reported honestly');
ok(verifyGraphLayer(GL('1/12'), 120, 2, 44100, renderGraphLayer(GL('0'), 120, 2, 44100).data).verdict === 'fail', 'graph: detects audio one semitone off its graph');

// Every built-in instrument
for (const item of LIBRARY) {
  const dur = item.mode === 'oneshot' ? item.length : 1.2;
  const t0 = performance.now();
  const r = verifyFormula(item.formula, { f: 220, duration: dur });
  const ms = (performance.now() - t0).toFixed(0);
  const freqs = r.found.map((s) => `${s.predicted.toFixed(1)}->${s.measured?.toFixed(1) ?? s.status}`).join(' ') + (r.explained ? ` peaks:${r.explained.status}` : '');
  const sw = r.sweep ? ` sweep:${r.sweep.status}${r.sweep.medianRelError != null ? ' ' + (r.sweep.medianRelError * 100).toFixed(1) + '%' : ''}` : '';
  ok(r.verdict === 'pass' && r.peak <= 1 && r.peak > 0.05, `${item.name.padEnd(14)} peak ${r.peak.toFixed(2)} ${freqs}${sw} (${ms} ms)`);
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
