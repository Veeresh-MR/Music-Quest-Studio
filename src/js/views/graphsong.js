// Graph Song: songs written as formula graphs (like graphing-calculator songs). Each layer y = g(x)
// is drawn on the graph and heard as pitch (base * 2^y). Every layer can be verified.
import { h, fitCanvas, noteName, toast, uid, debounce } from '../util.js';
import { check } from '../formula.js';
import { store, update } from '../project.js';
import { renderGraphSong, verifyGraphLayer, drawGraph, graphSeconds, WAVES, GRAPH_RULE, EXAMPLE, LAYER_COLORS } from '../graph.js';
import { encodeWav } from '../wav.js';
import { saveBytes } from '../io.js';
import { generateGraphSong, isConfigured } from '../ai.js';
import { VIDEO_LAYOUTS } from '../video.js';

export function createGraphSong(app) {
  const canvas = h('canvas', { class: 'plot', style: { background: '#fff' } });
  const layersEl = h('div', { class: 'graph-layers' });
  const results = h('div');
  const status = h('div', { class: 'hint' });
  const barsSel = h('select', { title: 'Length', onchange: () => setGraph((g) => { g.bars = +barsSel.value; }) },
    [1, 2, 4, 8, 16, 32].map((n) => h('option', { value: n }, `${n} bar${n > 1 ? 's' : ''}`)));
  const bpmIn = h('input', { type: 'number', min: 40, max: 240, style: { width: '64px' }, title: 'Tempo (BPM)', onchange: () => setGraph((g) => { g.bpm = Math.max(40, Math.min(240, Math.round(+bpmIn.value || 120))); }) });
  const playBtn = h('button', { class: 'btn primary', onclick: togglePlay }, '▶ Play');
  const layoutSel = h('select', { title: 'Video shape' }, Object.entries(VIDEO_LAYOUTS).map(([k, l]) => h('option', { value: k }, l.label.split(' (')[0])));
  const aiIn = h('input', { type: 'text', placeholder: 'Describe a graph song, e.g. "sad slow piano-like melody with a soft kick"', style: { flex: 1 } });
  const aiBtn = h('button', { class: 'btn', onclick: aiGenerate }, 'Generate with AI');
  aiIn.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') aiGenerate(); });

  const root = h('div', { class: 'view', id: 'view-graph' },
    h('div', { class: 'view-bar' },
      h('span', { class: 'title' }, 'Graph Song'),
      barsSel, h('label', { class: 'hint' }, 'BPM ', bpmIn), playBtn,
      h('button', { class: 'btn', onclick: verifyAll }, 'Verify'),
      h('button', { class: 'btn', onclick: exportWav }, 'Export WAV'),
      layoutSel, h('button', { class: 'btn', onclick: exportMp4 }, 'Export MP4'),
      h('button', { class: 'btn small', onclick: loadExample }, 'Load example'),
      h('span', { class: 'hint' }, 'x = beats, y = pitch in octaves above the base note (1/12 = one semitone), nan = silence.')),
    h('div', { class: 'view-body' }, h('div', { class: 'graph-layout' },
      h('div', { class: 'graph-left' },
        layersEl,
        h('button', { class: 'btn', onclick: addLayer }, '+ Add layer'),
        h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'AI (GEMINI)'), h('div', { class: 'row' }, aiIn, aiBtn), status)),
      h('div', { class: 'graph-right' },
        h('div', { class: 'card' }, canvas),
        h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'VERIFICATION (HERMANN 2008, C1-C4)'), results)))));

  const graph = () => store.project.graph;
  let playing = null; // { src, start }

  function setGraph(fn, coalesce = null) {
    stop();
    update((p) => fn(p.graph), { what: 'graph', coalesce });
    results.replaceChildren(h('p', { class: 'hint' }, 'Changed. Press Verify to check the new version.'));
    draw();
  }

  function renderLayers() {
    const g = graph();
    barsSel.value = g.bars;
    bpmIn.value = g.bpm;
    if (!g.layers.length) {
      layersEl.replaceChildren(h('p', { class: 'hint' }, 'No layers yet. Click "Load example", add a layer, or describe a song for the AI.'));
      return;
    }
    layersEl.replaceChildren(...g.layers.map((l, i) => {
      const err = h('div', { class: 'formula-error' });
      const formula = h('textarea', { class: 'formula-input', rows: 2, spellcheck: false, value: l.formula });
      formula.value = l.formula;
      const commit = debounce(() => {
        const e = check(formula.value);
        err.textContent = e ? e.message : '';
        formula.classList.toggle('bad', !!e);
        if (!e) setGraph((gr) => { gr.layers[i].formula = formula.value; }, `gf${l.id}`);
      }, 350);
      formula.addEventListener('input', commit);
      formula.addEventListener('keydown', (e) => e.stopPropagation());
      const key = h('select', { title: 'Base note (y = 0)', onchange: () => setGraph((gr) => { gr.layers[i].key = +key.value; }) });
      for (let k = 96; k >= 24; k--) key.append(h('option', { value: k }, noteName(k)));
      key.value = l.key;
      const wave = h('select', { title: 'Tone', onchange: () => setGraph((gr) => { gr.layers[i].wave = wave.value; }) },
        Object.entries(WAVES).map(([k, w]) => h('option', { value: k }, w.label)));
      wave.value = l.wave;
      const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: l.volume, title: 'Volume', style: { width: '90px' },
        oninput: () => setGraph((gr) => { gr.layers[i].volume = +vol.value; }, `gv${l.id}`) });
      const name = h('input', { type: 'text', value: l.name, style: { width: '110px' },
        onchange: () => setGraph((gr) => { gr.layers[i].name = name.value.slice(0, 30) || 'Layer'; }) });
      name.addEventListener('keydown', (e) => e.stopPropagation());
      return h('div', { class: 'card graph-layer', style: { borderLeft: `4px solid ${LAYER_COLORS[i % LAYER_COLORS.length]}` } },
        h('div', { class: 'row', style: { alignItems: 'center' } },
          name, key, wave, vol,
          h('label', { class: 'hint' }, h('input', { type: 'checkbox', checked: l.mute, onchange: (e) => setGraph((gr) => { gr.layers[i].mute = e.target.checked; }) }), ' mute'),
          h('button', { class: 'icon-btn', title: 'Delete layer', onclick: () => { setGraph((gr) => { gr.layers.splice(i, 1); }); renderLayers(); } }, '✕')),
        formula, err);
    }));
  }

  function addLayer() {
    setGraph((g) => { g.layers.push({ id: uid('gl'), name: `Layer ${g.layers.length + 1}`, formula: 'if(0.5 - frac(x), 0, nan)', key: 57, volume: 0.4, wave: 'sine', mute: false }); });
    renderLayers();
  }

  function loadExample() {
    setGraph((g) => { Object.assign(g, { bars: EXAMPLE.bars, bpm: EXAMPLE.bpm, layers: EXAMPLE.layers.map((l) => ({ ...l, id: uid('gl'), mute: false })) }); });
    renderLayers();
    toast('Example loaded: "Phonk, but it\'s math". Press Play.', 'ok');
  }

  function draw(playX = null) {
    if (!root.classList.contains('on')) return;
    const w = canvas.parentElement.clientWidth - 22;
    const ctx = fitCanvas(canvas, w, Math.max(320, Math.min(520, w * 0.55)));
    drawGraph(ctx, w, canvas.clientHeight, graph(), graph().bpm, playX ?? 0, { colors: LAYER_COLORS, span: 8 });
  }

  function mixBuffer(ctx) {
    const { mix, gain, seconds } = renderGraphSong(graph(), graph().bpm, 44100);
    const buf = ctx.createBuffer(2, mix.length, 44100);
    buf.copyToChannel(mix, 0);
    buf.copyToChannel(mix, 1);
    return { buf, mix, gain, seconds };
  }

  function stop() {
    if (!playing) return;
    try { playing.src.stop(); } catch { /* already stopped */ }
    playing = null;
    playBtn.textContent = '▶ Play';
  }

  function togglePlay() {
    if (playing) { stop(); draw(); return; }
    if (!graph().layers.some((l) => !l.mute)) return toast('Add a layer first (or Load example).', 'info');
    const ctx = app.engine.ensure();
    const { buf, gain } = mixBuffer(ctx);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start();
    playing = { src, start: ctx.currentTime };
    playBtn.textContent = '■ Stop';
    if (gain !== 1) status.textContent = `Layers together were louder than 1.0, so the mix was scaled by ${gain.toFixed(2)}.`;
    src.onended = () => { if (playing?.src === src) { playing = null; playBtn.textContent = '▶ Play'; draw(); } };
    const frame = () => {
      if (playing?.src !== src) return;
      draw(((ctx.currentTime - playing.start) * graph().bpm) / 60);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  async function verifyAll() {
    const g = graph();
    const layers = g.layers.filter((l) => !l.mute);
    if (!layers.length) return;
    results.replaceChildren(h('div', { class: 'progress' }, h('i')));
    const seconds = graphSeconds(g, g.bpm);
    const cards = [];
    for (const l of layers) {
      await new Promise((r) => setTimeout(r, 0));
      const r = verifyGraphLayer(l, g.bpm, seconds);
      const i = g.layers.indexOf(l);
      cards.push(h('div', { class: 'cond', style: { borderLeft: `4px solid ${LAYER_COLORS[i % LAYER_COLORS.length]}`, marginBottom: '8px' } },
        h('b', {}, h('span', { class: `badge ${r.verdict}` }, r.verdict.toUpperCase()), ` ${l.name}`),
        ...r.conditions.filter((c) => c.id !== 'C2').map((c) => h('p', {}, `${c.id} ${c.title}: ${c.status.toUpperCase()}. ${c.detail}`)),
        h('p', {}, `Silent (graph undefined) ${r.silentPct.toFixed(0)}% of the time. Max sample difference ${r.numeric.maxAbs.toExponential(1)}.`),
        ...r.warnings.map((w) => h('p', { style: { color: 'var(--warn)' } }, w))));
    }
    results.replaceChildren(...cards, h('p', { class: 'hint' }, `C2 rule for every layer: ${GRAPH_RULE}`));
  }

  async function exportWav() {
    const ctx = app.engine.ensure();
    const { mix } = mixBuffer(ctx);
    try {
      const path = await saveBytes(encodeWav([mix, mix], 44100), { defaultName: `${store.project.name} - graph song.wav`, filterName: 'WAV audio', extensions: ['wav'] });
      if (path) toast(`Saved ${path}`, 'ok', 6000);
    } catch (err) { toast(`Could not save: ${err.message || err}`, 'bad'); }
  }

  async function exportMp4() {
    const ctx = app.engine.ensure();
    const { buf } = mixBuffer(ctx);
    const g = JSON.parse(JSON.stringify(graph()));
    status.replaceChildren(h('div', { class: 'progress' }, h('i')), h('div', { class: 'hint' }, 'Making the video ...'));
    try {
      const { encodeMp4 } = await import('../video.js');
      const bytes = await encodeMp4(buf, {
        layout: layoutSel.value, title: store.project.name, subtitle: '',
        draw: (c, W, H, t) => drawGraph(c, W, H, g, g.bpm, (t * g.bpm) / 60, { colors: LAYER_COLORS, span: 8 }),
        onProgress: (f) => { status.lastChild.textContent = `Making the video ... ${Math.round(f * 100)}%`; },
      });
      const path = await saveBytes(bytes, { defaultName: `${store.project.name} - graph song.mp4`, filterName: 'MP4 video', extensions: ['mp4'] });
      status.textContent = path ? `Saved ${path}` : '';
    } catch (err) { status.textContent = `Video failed: ${err.message || err}`; }
  }

  async function aiGenerate() {
    const text = aiIn.value.trim();
    if (!text) return aiIn.focus();
    if (!isConfigured()) return app.openAiSettings();
    aiBtn.disabled = true;
    status.replaceChildren(h('div', { class: 'progress' }, h('i')), h('div', { class: 'hint' }, 'Asking Gemini ...'));
    try {
      const song = await generateGraphSong(text, (m) => { status.lastChild.textContent = m; });
      setGraph((g) => { Object.assign(g, { bars: song.bars, bpm: song.bpm, layers: song.layers.map((l) => ({ ...l, id: uid('gl'), mute: false })) }); });
      renderLayers();
      status.textContent = `Generated ${song.layers.length} layers. Press Play, then Verify.`;
    } catch (err) {
      status.textContent = `AI error: ${err.message || err}`;
    } finally {
      aiBtn.disabled = false;
    }
  }

  new ResizeObserver(debounce(() => { if (!playing) draw(); }, 80)).observe(root);

  return {
    id: 'graph', label: 'Graph Song', key: 'F4', root,
    onShow() { renderLayers(); draw(); },
    onChange(what) { if (what === 'all') { stop(); renderLayers(); draw(); } },
  };
}
