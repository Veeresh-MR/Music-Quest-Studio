// Formula Lab: write a formula, hear it, see it, and verify that the audio is correct.
import { h, fitCanvas, cssVar, debounce, noteName, toast, clamp } from '../util.js';
import { FUNCTIONS, FormulaError, compile } from '../formula.js';
import { renderFormula, applyFades, keyToFreq, LIBRARY, RENDER_RULE } from '../synth.js';
import { verifyFormula } from '../verify.js';
import { store, update, makeChannel } from '../project.js';
import { encodeWav } from '../wav.js';
import { saveBytes } from '../io.js';
import { generateSound, isConfigured, lastModelUsed } from '../ai.js';

const SR = 44100;
const fmtHz = (x) => (x == null ? '—' : `${x.toFixed(x < 100 ? 2 : 1)} Hz`);

export function createLab(app) {
  const state = { name: 'New Sound', mode: 'note', length: 1, release: 0.2, key: 57, vel: 1, duration: 1.5, linked: null };

  const input = h('textarea', { class: 'formula-input', spellcheck: false, 'aria-label': 'Formula' });
  const errorLine = h('div', { class: 'formula-error', 'aria-live': 'polite' });
  const nameInput = h('input', { type: 'text', value: state.name, oninput: (e) => { state.name = e.target.value; } });
  const modeSelect = h('select', { onchange: (e) => { state.mode = e.target.value; syncFields(); scheduleVerify(); } },
    h('option', { value: 'note' }, 'Note (follows pitch)'), h('option', { value: 'oneshot' }, 'One-shot (drum / FX)'));
  const lengthInput = h('input', { type: 'number', min: 0.02, max: 12, step: 0.05, oninput: (e) => { state.length = clamp(+e.target.value || 1, 0.02, 12); scheduleVerify(); } });
  const releaseInput = h('input', { type: 'number', min: 0, max: 4, step: 0.05, oninput: (e) => { state.release = clamp(+e.target.value || 0, 0, 4); } });
  const keySelect = h('select', { onchange: (e) => { state.key = +e.target.value; scheduleVerify(); } });
  for (let k = 96; k >= 24; k--) keySelect.append(h('option', { value: k }, `${noteName(k)}  (${keyToFreq(k).toFixed(2)} Hz)`));
  const durInput = h('input', { type: 'number', min: 0.1, max: 8, step: 0.1, oninput: (e) => { state.duration = clamp(+e.target.value || 1, 0.1, 8); scheduleVerify(); } });
  const lengthField = h('label', { class: 'field' }, 'Length (s)', lengthInput);
  const releaseField = h('label', { class: 'field' }, 'Release (s)', releaseInput);
  const durField = h('label', { class: 'field' }, 'Analyse (s)', durInput);
  const linkedLabel = h('div', { class: 'hint' });
  const saveBtn = h('button', { class: 'btn primary', onclick: saveToChannel }, 'Save to channel');

  const libSelect = h('select', { onchange: (e) => { if (e.target.value) loadLibrary(e.target.value); e.target.value = ''; } },
    h('option', { value: '' }, 'Load an instrument ...'),
    [...new Set(LIBRARY.map((i) => i.group))].map((g) => h('optgroup', { label: g },
      LIBRARY.filter((i) => i.group === g).map((i) => h('option', { value: i.name }, i.name)))));

  const aiInput = h('input', { type: 'text', placeholder: 'e.g. soft marimba, distorted phonk cowbell, deep tabla hit', style: { flex: 1 } });
  const aiBtn = h('button', { class: 'btn', onclick: aiGenerate }, 'Generate');
  const aiNote = h('div', { class: 'hint' });

  // right side
  const verdict = h('div');
  const waveCanvas = h('canvas', { class: 'plot' });
  const waveZoom = h('select', { onchange: () => drawWave() },
    h('option', { value: 'all' }, 'Whole sound'), h('option', { value: '0.05' }, 'First 50 ms'), h('option', { value: '0.01' }, 'First 10 ms'));
  const specCanvas = h('canvas', { class: 'plot' });
  const trackCanvas = h('canvas', { class: 'plot' });
  const trackCard = h('div', { class: 'card', style: { display: 'none' } },
    h('div', { class: 'card-title' }, 'PITCH TRACK  •  predicted (line) vs measured (dots)'), trackCanvas);
  const condsEl = h('div', { class: 'conds' });
  const freqEl = h('div');
  const statsEl = h('div');

  let result = null;
  let playing = null; // { start, duration, src }
  let verifyToken = 0;

  const left = h('div', { class: 'lab-left' },
    h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'FORMULA  y = F(t, f, v)', libSelect),
      input, errorLine,
      h('div', { class: 'hint' }, 't = time since the note started (s), f = note frequency (Hz), v = velocity (0-1).')),
    h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'SOUND'),
      h('div', { class: 'row' }, h('label', { class: 'field' }, 'Name', nameInput)),
      h('div', { class: 'row', style: { marginTop: '8px' } }, h('label', { class: 'field' }, 'Mode', modeSelect), lengthField, releaseField),
      h('div', { class: 'row', style: { marginTop: '8px' } }, h('label', { class: 'field', style: { flex: 2 } }, 'Test note', keySelect), durField)),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: play }, '▶  Play'),
      h('button', { class: 'btn', onclick: () => runVerify(true) }, 'Verify'),
      h('button', { class: 'btn', onclick: exportWav }, 'Export WAV'),
      h('span', { class: 'spacer' })),
    h('div', { class: 'row' }, saveBtn, h('button', { class: 'btn', onclick: addChannel }, 'Add as new channel')),
    linkedLabel,
    h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'DESCRIBE A SOUND (AI)'),
      h('div', { class: 'row' }, aiInput, aiBtn), aiNote),
    h('details', { class: 'card' },
      h('summary', { class: 'card-title', style: { cursor: 'default' } }, 'FUNCTION REFERENCE'),
      h('table', { class: 'data' }, h('tbody', {}, Object.entries(FUNCTIONS).map(([n, [a, , d]]) =>
        h('tr', {}, h('td', { class: 'num' }, `${n}(${a === 1 ? 'x' : a === 2 ? 'a, b' : 'x, a, b'})`), h('td', {}, d))))),
      h('p', { class: 'hint' }, 'Constants: pi, tau = 2·pi, e. Operators: + − * / % ^. A tone of F Hz is sin(tau*F*t) or saw(F*t).')));

  const right = h('div', { class: 'lab-right' },
    verdict,
    h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'WAVEFORM  y(t)', waveZoom), waveCanvas),
    h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'SPECTRUM (FFT)  •  orange = predicted from formula, green = measured peak explained, red = unexplained'), specCanvas),
    trackCard,
    h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'CORRECTNESS CONDITIONS (HERMANN 2008)'), condsEl),
    h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'FREQUENCY CHECKS'), freqEl),
    h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'NUMBERS', h('button', { class: 'btn small', onclick: copyReport }, 'Copy report')), statsEl));

  const root = h('div', { class: 'view', id: 'view-lab' },
    h('div', { class: 'view-bar' },
      h('span', { class: 'title' }, 'Formula Lab'),
      h('span', { class: 'hint' }, 'Every sound is computed from its formula and checked: independent recalculation, FFT frequency match and reproducibility.')),
    h('div', { class: 'view-body' }, h('div', { class: 'lab' }, left, right)));

  function syncFields() {
    nameInput.value = state.name;
    modeSelect.value = state.mode;
    lengthInput.value = state.length;
    releaseInput.value = state.release;
    keySelect.value = state.key;
    durInput.value = state.duration;
    lengthField.style.display = state.mode === 'oneshot' ? '' : 'none';
    releaseField.style.display = state.mode === 'note' ? '' : 'none';
    durField.style.display = state.mode === 'note' ? '' : 'none';
    const ch = store.project.channels.find((c) => c.id === state.linked);
    linkedLabel.textContent = ch ? `Editing channel "${ch.name}". Save to update it (undo with Ctrl+Z).` : 'Not linked to a channel. Use "Add as new channel" to use it in songs.';
    saveBtn.disabled = !ch;
  }

  function setSound(s, linked = null) {
    Object.assign(state, { name: s.name, mode: s.mode, length: s.length ?? 1, release: s.release ?? 0.2, linked });
    input.value = s.formula;
    syncFields();
    runVerify(true);
  }

  function loadLibrary(name) {
    const item = LIBRARY.find((i) => i.name === name);
    if (item) setSound(item, null);
  }

  const analysisDuration = () => (state.mode === 'oneshot' ? state.length : state.duration);

  function validate() {
    try {
      compile(input.value);
      input.classList.remove('bad');
      errorLine.textContent = '';
      return true;
    } catch (err) {
      if (!(err instanceof FormulaError)) throw err;
      input.classList.add('bad');
      const line = input.value.replace(/\n/g, ' ');
      const start = Math.max(0, err.pos - 30);
      errorLine.textContent = `${err.message}\n${line.slice(start, err.pos + 30)}\n${' '.repeat(err.pos - start)}^`;
      return false;
    }
  }

  function runVerify(now = false) {
    if (!validate()) return;
    const token = ++verifyToken;
    const work = () => {
      if (token !== verifyToken) return;
      const t0 = performance.now();
      try {
        result = verifyFormula(input.value, { f: keyToFreq(state.key), v: state.vel, duration: analysisDuration(), sampleRate: SR });
        result.ms = performance.now() - t0;
      } catch (err) {
        result = null;
        verdict.replaceChildren(h('div', { class: 'verdict fail' }, `Could not verify: ${err.message}`));
        return;
      }
      showResult();
    };
    if (now) setTimeout(work, 0); else work();
  }
  const scheduleVerify = debounce(() => runVerify(), 450);
  input.addEventListener('input', () => { if (validate()) scheduleVerify(); });
  input.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); play(); }
    e.stopPropagation();
  });

  function badge(status) {
    return h('span', { class: `badge ${status}` }, status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'N/A');
  }

  function showResult() {
    const r = result;
    verdict.replaceChildren(h('div', { class: `verdict ${r.verdict}` },
      h('span', { style: { fontSize: '18px' } }, r.verdict === 'pass' ? '✓' : '✗'),
      h('div', {}, r.verdict === 'pass' ? 'Verified: this audio is exactly what the formula describes.' : 'Not verified: see the failed checks below.',
        h('small', {}, `${r.numeric.samples.toLocaleString()} samples at ${r.sampleRate} Hz, test note ${noteName(state.key)} = ${r.f.toFixed(2)} Hz, analysed in ${r.ms.toFixed(0)} ms`))));

    condsEl.replaceChildren(...r.conditions.map((c) => h('div', { class: 'cond' }, h('b', {}, badge(c.status), `${c.id}  ${c.title}`), h('p', {}, c.detail))));

    const parts = [];
    if (r.found.length) {
      parts.push(h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Predicted from formula'), h('th', {}, 'Measured (FFT)'), h('th', {}, 'Error'), h('th', {}, 'Result'))),
        h('tbody', {}, r.found.map((f) => h('tr', {},
          h('td', { class: 'num' }, fmtHz(f.predicted), f.kind === 'fm' ? h('span', { class: 'muted' }, ` FM carrier, modulator ${f.modFreqs.map(fmtHz).join(', ')}`) : null),
          h('td', { class: 'num' }, fmtHz(f.measured)),
          h('td', { class: 'num' }, f.error != null ? `${f.error.toFixed(3)} Hz` : ''),
          h('td', {}, badge(f.status), f.reason ? h('div', { class: 'muted' }, f.reason) : null))))));
    }
    if (r.explained) {
      parts.push(h('p', { class: 'hint' }, `Strongest ${r.explained.peaks.length} peaks in the audio, each must be explained by the formula:`));
      parts.push(h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Measured peak'), h('th', {}, 'Level'), h('th', {}, 'Explained by'), h('th', {}, 'Result'))),
        h('tbody', {}, r.explained.peaks.map((p) => h('tr', {},
          h('td', { class: 'num' }, fmtHz(p.freq)), h('td', { class: 'num' }, `${p.levelDb.toFixed(1)} dB`),
          h('td', {}, p.explainedBy || 'not predicted'), h('td', {}, badge(p.status)))))));
    }
    if (r.sweep) {
      parts.push(h('p', {}, badge(r.sweep.status), ' Changing pitch: ',
        r.sweep.medianRelError != null
          ? `predicted ${fmtHz(r.sweep.start)} → ${fmtHz(r.sweep.end)}, median error ${(r.sweep.medianRelError * 100).toFixed(2)}% over ${r.sweep.track.length} frames.`
          : r.sweep.reason));
    }
    if (!parts.length) parts.push(h('p', { class: 'hint' }, 'No steady tone in this formula (for example pure noise), so only the sample-by-sample check applies.'));
    if (r.notes.length) parts.push(h('ul', { class: 'note-list' }, r.notes.map((n) => h('li', {}, n))));
    if (r.warnings.length) parts.push(h('ul', { class: 'warn-list' }, r.warnings.map((w) => h('li', {}, w))));
    freqEl.replaceChildren(...parts);

    statsEl.replaceChildren(h('table', { class: 'data' }, h('tbody', {},
      [['Samples checked', r.numeric.samples.toLocaleString()],
        ['Max difference vs independent calculation', r.numeric.maxAbs.toExponential(2)],
        ['Samples outside float32 rounding', String(r.numeric.failures)],
        ['Peak level', `${r.peak.toFixed(3)} (${(20 * Math.log10(r.peak || 1e-9)).toFixed(1)} dBFS)`],
        ['Samples above 1.0', String(r.clipped)],
        ['Frequency resolution', `${r.resolution.toFixed(2)} Hz`],
        ['Fingerprint (FNV-1a)', r.hash],
        ['Rule', RENDER_RULE]].map(([k, v]) => h('tr', {}, h('td', { class: 'muted' }, k), h('td', { class: 'num' }, v))))));

    drawWave();
    drawSpectrum();
    drawTrack();
  }

  function drawWave(playT = null) {
    if (!result) return;
    const w = waveCanvas.parentElement.clientWidth - 22, hgt = 150;
    const ctx = fitCanvas(waveCanvas, w, hgt);
    ctx.fillStyle = cssVar('--bg-deep');
    ctx.fillRect(0, 0, w, hgt);
    const zoom = waveZoom.value === 'all' ? null : +waveZoom.value;
    const data = result.data;
    const n = zoom ? Math.min(data.length, Math.round(zoom * SR)) : data.length;
    const scale = Math.max(1, Math.max(result.peak, 1));
    const mid = hgt / 2;
    ctx.fillStyle = '#20262b';
    for (const y of [-1, -0.5, 0.5, 1]) ctx.fillRect(0, mid - (y / scale) * (mid - 6), w, 1);
    ctx.fillStyle = '#3b444d';
    ctx.fillRect(0, mid, w, 1);
    ctx.fillStyle = cssVar('--accent');
    ctx.strokeStyle = cssVar('--accent');
    if (n / w > 2) {
      for (let x = 0; x < w; x++) {
        const a = Math.floor((x / w) * n), b = Math.max(a + 1, Math.floor(((x + 1) / w) * n));
        let lo = Infinity, hi = -Infinity;
        for (let i = a; i < b; i++) { lo = Math.min(lo, data[i]); hi = Math.max(hi, data[i]); }
        const y1 = mid - (hi / scale) * (mid - 6), y2 = mid - (lo / scale) * (mid - 6);
        ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
      }
    } else {
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * w, y = mid - (data[i] / scale) * (mid - 6);
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.fillStyle = cssVar('--text-faint');
    ctx.font = `10px ${cssVar('--ui')}`;
    ctx.fillText(`${((n / SR) * 1000).toFixed(n / SR < 1 ? 1 : 0)} ms`, w - 52, hgt - 6);
    ctx.fillText('+1', 4, mid - (1 / scale) * (mid - 6) + 10);
    if (playT != null) {
      const x = (playT * SR / n) * w;
      if (x <= w) { ctx.fillStyle = '#fff'; ctx.fillRect(x, 0, 1.5, hgt); }
    }
  }

  function drawSpectrum() {
    const r = result;
    if (!r) return;
    const w = specCanvas.parentElement.clientWidth - 22, hgt = 190;
    const ctx = fitCanvas(specCanvas, w, hgt);
    ctx.fillStyle = cssVar('--bg-deep');
    ctx.fillRect(0, 0, w, hgt);
    const fMin = 20, fMax = r.sampleRate / 2;
    const xOf = (f) => (Math.log(f / fMin) / Math.log(fMax / fMin)) * w;
    const fOf = (x) => fMin * Math.pow(fMax / fMin, x / w);
    const mag = r.spectrum;
    let max = 1e-30;
    for (let k = 1; k < mag.length; k++) max = Math.max(max, mag[k]);
    const yOf = (db) => 8 + (-db / 100) * (hgt - 24);
    ctx.font = `10px ${cssVar('--ui')}`;
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
      const x = xOf(f);
      ctx.fillStyle = '#20262b';
      ctx.fillRect(x, 0, 1, hgt - 14);
      ctx.fillStyle = cssVar('--text-faint');
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 2, hgt - 3);
    }
    for (const db of [-20, -40, -60, -80]) {
      ctx.fillStyle = '#20262b';
      ctx.fillRect(0, yOf(db), w, 1);
      ctx.fillStyle = cssVar('--text-faint');
      ctx.fillText(`${db} dB`, 4, yOf(db) - 2);
    }
    // predicted markers
    ctx.strokeStyle = cssVar('--accent');
    ctx.setLineDash([3, 3]);
    for (const f of r.found) {
      const x = xOf(f.predicted);
      ctx.beginPath(); ctx.moveTo(x, 4); ctx.lineTo(x, hgt - 14); ctx.stroke();
    }
    if (r.sweep?.start) {
      ctx.fillStyle = 'rgba(242,155,56,0.12)';
      const a = xOf(Math.max(fMin, Math.min(r.sweep.start, r.sweep.end))), b = xOf(Math.max(r.sweep.start, r.sweep.end));
      ctx.fillRect(a, 4, Math.max(2, b - a), hgt - 18);
    }
    ctx.setLineDash([]);
    // measured spectrum
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const k0 = Math.max(1, Math.floor(fOf(x) / r.binHz)), k1 = Math.max(k0 + 1, Math.floor(fOf(x + 1) / r.binHz));
      let m = 0;
      for (let k = k0; k < k1 && k < mag.length; k++) m = Math.max(m, mag[k]);
      const db = Math.max(-100, 20 * Math.log10((m + 1e-30) / max));
      if (x) ctx.lineTo(x, yOf(db)); else ctx.moveTo(x, yOf(db));
    }
    ctx.strokeStyle = '#9fb7c9';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    // explained / unexplained peaks
    for (const p of r.explained?.peaks || []) {
      const x = xOf(p.freq), y = yOf(p.levelDb);
      ctx.fillStyle = p.status === 'pass' ? cssVar('--ok') : cssVar('--bad');
      ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x - 4, y - 11); ctx.lineTo(x + 4, y - 11); ctx.fill();
    }
    for (const f of r.found) {
      if (f.measured == null) continue;
      const x = xOf(f.measured), y = yOf(f.levelDb ?? 0);
      ctx.fillStyle = f.status === 'pass' ? cssVar('--ok') : cssVar('--bad');
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawTrack() {
    const track = result?.sweep?.track || [];
    trackCard.style.display = track.length ? '' : 'none';
    if (!track.length) return;
    const w = trackCanvas.parentElement.clientWidth - 22, hgt = 150;
    const ctx = fitCanvas(trackCanvas, w, hgt);
    ctx.fillStyle = cssVar('--bg-deep');
    ctx.fillRect(0, 0, w, hgt);
    const tMax = Math.max(...track.map((p) => p.t));
    const fs = track.flatMap((p) => [p.predicted, p.measured]);
    const lo = Math.min(...fs) * 0.9, hi = Math.max(...fs) * 1.1;
    const xOf = (t) => 30 + (t / tMax) * (w - 40);
    const yOf = (f) => hgt - 16 - ((f - lo) / (hi - lo)) * (hgt - 28);
    ctx.font = `10px ${cssVar('--ui')}`;
    ctx.fillStyle = cssVar('--text-faint');
    ctx.fillText(fmtHz(hi), 2, 12);
    ctx.fillText(fmtHz(lo), 2, hgt - 18);
    ctx.fillText(`${tMax.toFixed(2)} s`, w - 40, hgt - 3);
    ctx.beginPath();
    track.forEach((p, i) => (i ? ctx.lineTo(xOf(p.t), yOf(p.predicted)) : ctx.moveTo(xOf(p.t), yOf(p.predicted))));
    ctx.strokeStyle = cssVar('--accent');
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = cssVar('--ok');
    for (const p of track) { ctx.beginPath(); ctx.arc(xOf(p.t), yOf(p.measured), 2.2, 0, Math.PI * 2); ctx.fill(); }
  }

  function currentSound() {
    return { name: state.name.trim() || 'Sound', formula: input.value, mode: state.mode, length: state.length, release: state.release };
  }

  function play() {
    if (!validate()) return toast('Fix the formula first.', 'bad');
    const ctx = app.engine.ensure();
    const duration = state.mode === 'oneshot' ? state.length : state.duration;
    const { data } = renderFormula(input.value, { f: keyToFreq(state.key), v: state.vel, duration, sampleRate: ctx.sampleRate });
    applyFades(data, ctx.sampleRate, state.mode === 'oneshot' ? 0 : state.release);
    const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
    buf.copyToChannel(data, 0);
    playing?.src.stop();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination); // direct: the Lab plays the formula with no effects
    src.start();
    playing = { start: ctx.currentTime, duration, src };
    src.onended = () => { if (playing?.src === src) { playing = null; drawWave(); } };
    const anim = () => {
      if (!playing || playing.src !== src) return;
      drawWave(ctx.currentTime - playing.start);
      requestAnimationFrame(anim);
    };
    requestAnimationFrame(anim);
  }

  async function exportWav() {
    if (!validate()) return toast('Fix the formula first.', 'bad');
    const duration = state.mode === 'oneshot' ? state.length : state.duration;
    const { data } = renderFormula(input.value, { f: keyToFreq(state.key), v: state.vel, duration, sampleRate: SR });
    const bytes = encodeWav([data], SR);
    try {
      const path = await saveBytes(bytes, { defaultName: `${state.name || 'sound'}.wav`, filterName: 'WAV audio', extensions: ['wav'] });
      if (path) toast(`Saved ${path}`, 'ok');
    } catch (err) {
      toast(`Could not save: ${err.message || err}`, 'bad');
    }
  }

  function saveToChannel() {
    if (!validate()) return toast('Fix the formula first.', 'bad');
    const s = currentSound();
    update((p) => {
      const ch = p.channels.find((c) => c.id === state.linked);
      if (ch) Object.assign(ch, { name: s.name.slice(0, 40), formula: s.formula, mode: s.mode, length: s.length, release: s.release });
    });
    toast(`Channel "${s.name}" updated.`, 'ok');
  }

  function addChannel() {
    if (!validate()) return toast('Fix the formula first.', 'bad');
    const s = currentSound();
    const palette = ['#e8743b', '#e0b84a', '#9fcf6a', '#64b5f6', '#7bd389', '#f06292', '#ffb74d', '#ba68c8'];
    const ch = makeChannel({ ...s, color: palette[store.project.channels.length % palette.length] });
    update((p) => { p.channels.push(ch); });
    state.linked = ch.id;
    app.selectChannel(ch.id);
    syncFields();
    toast(`Added channel "${ch.name}".`, 'ok');
  }

  async function aiGenerate() {
    const text = aiInput.value.trim();
    if (!text) return aiInput.focus();
    if (!isConfigured()) { app.openAiSettings(); return; }
    aiBtn.disabled = true;
    aiNote.replaceChildren(h('div', { class: 'progress' }, h('i')));
    try {
      const s = await generateSound(text, (msg) => aiNote.replaceChildren(h('div', { class: 'progress' }, h('i')), h('div', { class: 'hint' }, msg)));
      setSound(s, null);
      aiNote.textContent = `${s.explanation ? `AI: ${s.explanation}` : 'Generated. Check the verification on the right.'} (model: ${lastModelUsed})`;
    } catch (err) {
      aiNote.textContent = `AI error: ${err.message || err}`;
    } finally {
      aiBtn.disabled = false;
    }
  }
  aiInput.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') aiGenerate(); });

  function copyReport() {
    const r = result;
    if (!r) return;
    const lines = [
      'Quest Studio - verification report',
      `Formula: ${r.source}`,
      `Test note: ${noteName(state.key)} (f = ${r.f.toFixed(3)} Hz), v = ${r.v}, ${r.duration} s at ${r.sampleRate} Hz`,
      `Verdict: ${r.verdict.toUpperCase()}`,
      '',
      ...r.conditions.map((c) => `${c.id} ${c.title}: ${c.status.toUpperCase()} - ${c.detail}`),
      '',
      ...r.found.map((f) => `Tone predicted ${fmtHz(f.predicted)} measured ${fmtHz(f.measured)} ${f.status.toUpperCase()}${f.reason ? ` (${f.reason})` : ''}`),
      ...(r.explained?.peaks || []).map((p) => `Peak ${fmtHz(p.freq)} at ${p.levelDb.toFixed(1)} dB: ${p.explainedBy || 'not predicted'} ${p.status.toUpperCase()}`),
      r.sweep ? `Pitch glide: ${r.sweep.status.toUpperCase()} ${r.sweep.medianRelError != null ? `median error ${(r.sweep.medianRelError * 100).toFixed(2)}%` : r.sweep.reason}` : '',
      `Max sample difference: ${r.numeric.maxAbs.toExponential(2)}; fingerprint ${r.hash}`,
      ...r.warnings.map((w) => `Warning: ${w}`),
    ].filter((l) => l !== undefined);
    navigator.clipboard.writeText(lines.join('\n')).then(() => toast('Report copied.', 'ok'), () => toast('Clipboard not available.', 'bad'));
  }

  new ResizeObserver(debounce(() => { if (root.classList.contains('on') && result) { drawWave(); drawSpectrum(); drawTrack(); } }, 80)).observe(right);

  setSound(LIBRARY.find((i) => i.name === 'FM Rhodes'), null);

  return {
    id: 'lab', label: 'Formula Lab', key: 'F8', root,
    onChange(what) { if (what === 'all' || what === 'project') syncFields(); },
    onShow() { if (result) { drawWave(); drawSpectrum(); drawTrack(); } },
    openChannel(id) {
      const ch = store.project.channels.find((c) => c.id === id);
      if (ch) setSound(ch, ch.id);
    },
  };
}
