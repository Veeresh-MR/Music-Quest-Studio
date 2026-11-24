// Quest Studio entry point: wires the views, transport, menus and shortcuts together.
import { h, knob, toast, modal, uid } from './util.js';
import {
  store, subscribe, update, emit, undo, redo, newProject, loadProject, normalizeProject,
  restoreAutosave, currentPattern, makeChannel, makePattern, channelFromLibrary, STEPS_PER_BAR,
} from './project.js';
import { LIBRARY } from './synth.js';
import { Engine } from './engine.js';
import { VIDEO_LAYOUTS } from './video.js';
import { saveBytes, saveText, writeTextTo, openText, isDesktop } from './io.js';
import { loadSettings, saveSettings, PROVIDERS } from './ai.js';
import { showMenu, promptText } from './views/menu.js';
import { createRack } from './views/rack.js';
import { createPianoRoll } from './views/pianoroll.js';
import { createPlaylist } from './views/playlist.js';
import { createMixer } from './views/mixer.js';
import { createLab } from './views/lab.js';
import { createComposer } from './views/composer.js';
import { createGraphSong } from './views/graphsong.js';

const engine = new Engine(() => store.project);
const $ = (id) => document.getElementById(id);
const statusHint = $('status-hint');

const app = {
  engine,
  setView,
  setMode,
  selectChannel(id) { store.ui.channel = id; emit('selection'); },
  openInLab(id) { setView('lab'); views.lab.openChannel(id); },
  openPianoRoll(id) { app.selectChannel(id); setView('pianoroll'); },
  openAiSettings,
  playSongFrom(step) { store.ui.mode = 'song'; startPlayback('song', store.ui.pattern, step); },
};

const views = {
  playlist: createPlaylist(app),
  rack: createRack(app),
  pianoroll: createPianoRoll(app),
  mixer: createMixer(app),
  lab: createLab(app),
  composer: createComposer(app),
  graph: createGraphSong(app),
};

// ---------- tabs ----------
const tabButtons = {};
for (const v of Object.values(views)) {
  tabButtons[v.id] = h('button', { class: 'tab', role: 'tab', onclick: () => setView(v.id) }, v.label, h('kbd', {}, v.key));
  $('tabs').append(tabButtons[v.id]);
  $('views').append(v.root);
}

function setView(id) {
  store.ui.view = id;
  for (const v of Object.values(views)) {
    const on = v.id === id;
    v.root.classList.toggle('on', on);
    tabButtons[v.id].classList.toggle('on', on);
    tabButtons[v.id].setAttribute('aria-selected', on ? 'true' : 'false');
  }
  views[id].onShow?.();
}

// ---------- transport ----------
const playIcon = '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z"/></svg>';
const stopIcon = '<svg viewBox="0 0 24 24"><rect x="5.5" y="5.5" width="13" height="13" rx="1.5"/></svg>';
const modePat = h('button', { title: 'Play the selected pattern (L)', onclick: () => setMode('pattern') }, 'PAT');
const modeSong = h('button', { title: 'Play the whole song (L)', onclick: () => setMode('song') }, 'SONG');
const playBtn = h('button', { class: 'tbtn', title: 'Play / pause (Space)', onclick: togglePlay });
playBtn.innerHTML = playIcon;
const stopBtn = h('button', { class: 'tbtn', title: 'Stop', onclick: stop });
stopBtn.innerHTML = stopIcon;
const timeLcd = h('div', { class: 'lcd', title: 'Bar : beat : step' }, h('small', {}, 'TIME'), h('span', {}, '1:1:01'));
const bpmInput = h('input', { type: 'text', inputMode: 'numeric', value: store.project.bpm, 'aria-label': 'Tempo in BPM' });
const bpmLcd = h('div', { class: 'lcd bpm', title: 'Tempo: drag up/down, scroll, or type' }, h('small', {}, 'BPM'), bpmInput);
$('transport').append(h('div', { class: 'mode-toggle' }, modePat, modeSong), playBtn, stopBtn, timeLcd, bpmLcd);

function setTempo(bpm, coalesce = 'bpm') {
  const v = Math.round(Math.min(240, Math.max(40, bpm)));
  if (v === store.project.bpm) return;
  update((p) => { p.bpm = v; }, { what: 'tempo', coalesce });
  engine.retime();
}
bpmInput.addEventListener('change', () => setTempo(+bpmInput.value || store.project.bpm));
bpmInput.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') bpmInput.blur(); });
bpmLcd.addEventListener('wheel', (e) => { e.preventDefault(); setTempo(store.project.bpm - Math.sign(e.deltaY)); }, { passive: false });
bpmLcd.addEventListener('pointerdown', (e) => {
  if (e.target === bpmInput && document.activeElement === bpmInput) return;
  const startY = e.clientY, start = store.project.bpm;
  let moved = false;
  const move = (ev) => { if (Math.abs(ev.clientY - startY) > 2) { moved = true; setTempo(start + (startY - ev.clientY) / 3, 'bpmdrag'); } };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); if (moved) bpmInput.blur(); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

function setMode(mode) {
  store.ui.mode = mode;
  if (engine.playing) startPlayback(mode, store.ui.pattern, 0);
  refreshTransport();
}

// Prepares the sounds (with progress for big songs), then starts playing.
async function startPlayback(mode, patternId, fromStep) {
  refreshTransport();
  let shown = false;
  const started = await engine.play(mode, patternId, fromStep, (f) => {
    shown = true;
    statusHint.textContent = `Preparing sounds ... ${Math.round(f * 100)}%  (Space cancels)`;
  });
  if (shown) statusHint.textContent = started ? 'Playing.' : 'Cancelled.';
  refreshTransport();
}

function togglePlay() {
  if (engine.playing || engine.preparing) stop();
  else {
    if (store.ui.mode === 'song' && !store.project.playlist.length) {
      toast('The song is empty. Place patterns in the Playlist, or switch to PAT mode.', 'info');
      setView('playlist');
      return;
    }
    startPlayback(store.ui.mode, store.ui.pattern, 0);
  }
  refreshTransport();
}

function stop() {
  engine.stop();
  for (const v of Object.values(views)) v.clearTick?.();
  timeLcd.lastChild.textContent = '1:1:01';
  refreshTransport();
}

function refreshTransport() {
  modePat.classList.toggle('on', store.ui.mode === 'pattern');
  modeSong.classList.toggle('on', store.ui.mode === 'song');
  playBtn.classList.toggle('playing', engine.playing);
  if (document.activeElement !== bpmInput) bpmInput.value = store.project.bpm;
}

// ---------- pattern picker ----------
const patternSelect = h('select', { title: 'Selected pattern', onchange: () => selectPattern(patternSelect.value) });
$('pattern-picker').append(
  h('button', { class: 'icon-btn', title: 'Previous pattern', onclick: () => stepPattern(-1) }, '‹'),
  patternSelect,
  h('button', { class: 'icon-btn', title: 'Next pattern', onclick: () => stepPattern(1) }, '›'),
  h('button', { class: 'icon-btn', title: 'New pattern', onclick: addPattern }, '+'),
  h('button', { class: 'icon-btn', title: 'Pattern options', onclick: (e) => patternMenu(e) }, '⋯'));

function selectPattern(id) {
  store.ui.pattern = id;
  emit('selection');
  if (engine.playing && engine.mode === 'pattern') startPlayback('pattern', id, 0);
}
function stepPattern(d) {
  const list = store.project.patterns;
  const i = list.findIndex((p) => p.id === store.ui.pattern);
  selectPattern(list[(i + d + list.length) % list.length].id);
}
function addPattern() {
  const p = makePattern(store.project.patterns.length + 1);
  update((proj) => { proj.patterns.push(p); });
  selectPattern(p.id);
}
function patternMenu(e) {
  const r = e.currentTarget.getBoundingClientRect();
  const pat = currentPattern();
  showMenu(r.left, r.bottom + 4, [
    { label: 'Rename ...', run: async () => {
      const name = await promptText('Rename pattern', pat.name);
      if (name) update((p) => { p.patterns.find((x) => x.id === pat.id).name = name.slice(0, 40); });
    } },
    { label: 'Clone', run: () => {
      const copy = { ...JSON.parse(JSON.stringify(pat)), id: uid('pt'), name: `${pat.name} copy` };
      update((p) => { p.patterns.push(copy); });
      selectPattern(copy.id);
    } },
    { sep: true },
    { label: 'Delete pattern', danger: true, disabled: store.project.patterns.length <= 1, run: () => {
      update((p) => {
        p.patterns = p.patterns.filter((x) => x.id !== pat.id);
        p.playlist = p.playlist.filter((c) => c.pattern !== pat.id);
      });
      selectPattern(store.project.patterns[0].id);
    } },
  ]);
}
function renderPatternPicker() {
  patternSelect.replaceChildren(...store.project.patterns.map((p) => h('option', { value: p.id }, p.name)));
  patternSelect.value = store.ui.pattern;
}

// ---------- master volume ----------
const masterKnob = knob({ value: store.project.master.volume, min: 0, max: 1.25, def: 0.85, size: 26, title: 'Master volume', format: (v) => `${Math.round(v * 100)}%`,
  onInput: (v) => update((p) => { p.master.volume = v; }, { what: 'mixer', coalesce: 'master' }) });
$('master-volume').append(masterKnob);

// ---------- browser ----------
function renderBrowser() {
  const groups = [...new Set(LIBRARY.map((i) => i.group))];
  $('browser').replaceChildren(
    h('div', { class: 'browser-head' }, 'INSTRUMENTS', h('span', {}, 'formula-based')),
    ...groups.map((g) => h('details', { class: 'lib-group', open: true },
      h('summary', {}, g),
      LIBRARY.filter((i) => i.group === g).map((item) => h('button', {
        class: 'lib-item', title: `${item.note}\n\n${item.formula}\n\nClick to add to the Channel Rack. Right-click to preview.`,
        onclick: () => addInstrument(item.name),
        oncontextmenu: (e) => { e.preventDefault(); engine.preview(makeChannel(item), 57, 4); },
      }, h('i', { class: 'swatch', style: { background: item.color } }), item.name, h('span', { class: 'tag' }, item.mode === 'oneshot' ? 'hit' : 'note'))))),
    h('div', { class: 'lib-hint' }, 'Every instrument here is only a math formula. Open any channel in the Formula Lab to see, change and verify it.'));
}

function addInstrument(name) {
  const ch = channelFromLibrary(name);
  update((p) => { p.channels.push(ch); });
  app.selectChannel(ch.id);
  engine.preview(ch, 57, 4);
  if (store.ui.view !== 'rack' && store.ui.view !== 'mixer') setView('rack');
  statusHint.textContent = `Added ${name}. Paint steps in the Channel Rack or open the Piano Roll (F7).`;
}

// ---------- files ----------
function title() {
  document.title = `${store.dirty ? '• ' : ''}${store.project.name} - Quest Studio`;
}

async function confirmDiscard() {
  if (!store.dirty) return true;
  return new Promise((resolve) => {
    let answered = false;
    modal({
      title: 'Unsaved changes',
      body: h('p', {}, 'This project has changes that are not saved to a file. Continue anyway?'),
      actions: [{ label: 'Cancel', run: () => { answered = true; resolve(false); } }, { label: 'Continue', primary: true, run: () => { answered = true; resolve(true); } }],
    });
    const observer = new MutationObserver(() => { if (!document.querySelector('.modal-back')) { observer.disconnect(); if (!answered) resolve(false); } });
    observer.observe(document.body, { childList: true });
  });
}

async function fileNew() {
  if (!(await confirmDiscard())) return;
  stop();
  loadProject(newProject());
  toast('New project.', 'ok');
}

async function fileOpen() {
  if (!(await confirmDiscard())) return;
  try {
    const file = await openText({ filterName: 'Quest Studio project', extensions: ['quest', 'json'] });
    if (!file) return;
    const { project, problems } = normalizeProject(JSON.parse(file.text));
    stop();
    loadProject(project, file.path);
    toast(problems.length ? `Opened with ${problems.length} problem(s): ${problems[0]}` : `Opened ${project.name}.`, problems.length ? 'bad' : 'ok', 5000);
  } catch (err) {
    toast(`Could not open: ${err.message || err}`, 'bad', 5000);
  }
}

async function fileSave(saveAs = false) {
  const text = JSON.stringify(store.project, null, 1);
  try {
    if (isDesktop && store.filePath && !saveAs) {
      await writeTextTo(store.filePath, text);
    } else {
      const path = await saveText(text, { defaultName: `${store.project.name}.quest`, filterName: 'Quest Studio project', extensions: ['quest'] });
      if (!path) return;
      if (isDesktop) {
        store.filePath = path;
        const name = path.split(/[\\/]/).pop().replace(/\.quest$/i, '');
        if (name && name !== store.project.name) update((p) => { p.name = name; });
      }
    }
    store.dirty = false;
    title();
    toast('Project saved.', 'ok');
  } catch (err) {
    toast(`Could not save: ${err.message || err}`, 'bad', 5000);
  }
}

// Export window: WAV (lossless audio) or MP4 (AAC audio + visualizer video for YouTube / Reels).
let exporting = false;
function openExport(defaultFormat = 'wav') {
  if (exporting) return toast('An export is already running.', 'info');
  const hasSong = store.project.playlist.length > 0;
  const radios = (name, options, value) => h('div', { style: { display: 'grid', gap: '6px' } }, options.map(([v, label, disabled]) =>
    h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', opacity: disabled ? 0.5 : 1 } },
      h('input', { type: 'radio', name, value: v, checked: v === value, disabled: !!disabled }), label)));
  const formatGroup = radios('fmt', [['wav', 'WAV audio (lossless, best for music sites and editing)'], ['mp4', 'MP4 video (song + animated visualizer, for YouTube / Instagram)']], defaultFormat);
  const rangeGroup = radios('range', [['song', hasSong ? 'Whole song (Playlist)' : 'Whole song (Playlist is empty)', !hasSong], ['pattern', `Current pattern: ${currentPattern().name}`]], hasSong ? 'song' : 'pattern');
  const layoutGroup = radios('layout', Object.entries(VIDEO_LAYOUTS).map(([k, l]) => [k, l.label]), 'landscape');
  const layoutField = h('div', { class: 'field' }, 'Video shape', layoutGroup);
  const pick = (name) => formatGroup.ownerDocument.querySelector(`input[name="${name}"]:checked`)?.value;
  const sync = () => {
    const mp4 = pick('fmt') === 'mp4';
    layoutField.style.display = mp4 ? '' : 'none';
    if (!exporting) note.textContent = mp4
      ? 'Making the video takes about 1.5 to 2.5 times the song length (a 3-minute song: about 5 to 7 minutes). The default folder is Downloads.'
      : 'WAV is ready in a few seconds. You choose where to save; the default folder is Downloads.';
  };
  formatGroup.addEventListener('change', sync);
  const bar = h('i', { style: { width: '0%', animation: 'none', transition: 'width 0.2s' } });
  const progress = h('div', { class: 'progress', style: { display: 'none', height: '6px' } }, bar);
  const note = h('div', { class: 'hint' }, 'You choose where to save. The default folder is Downloads.');
  let cancelled = false;

  const dialog = modal({
    title: 'Export',
    body: h('div', { style: { display: 'grid', gap: '14px' } },
      h('div', { class: 'field' }, 'Format', formatGroup),
      h('div', { class: 'field' }, 'What to export', rangeGroup),
      layoutField, progress, note),
    actions: [
      { label: 'Cancel', run: () => { cancelled = true; } },
      { label: 'Export', primary: true, run: () => { run(); return false; } },
    ],
  });
  setTimeout(sync, 0);

  async function run() {
    if (exporting) return;
    exporting = true;
    const format = pick('fmt'), mode = pick('range'), layout = pick('layout');
    const exportBtn = [...dialog.box.querySelectorAll('.modal-foot .btn')].pop();
    exportBtn.disabled = true;
    progress.style.display = '';
    const say = (text, frac) => { note.textContent = text; if (frac != null) bar.style.width = `${Math.round(frac * 100)}%`; };
    try {
      const t0 = performance.now();
      say('Rendering the audio ...', 0.02);
      const name = mode === 'song' ? store.project.name : `${store.project.name} - ${currentPattern().name}`;
      let bytes;
      if (format === 'wav') {
        bytes = await engine.exportWav(mode, store.ui.pattern, 44100, (f) => say(`Preparing sounds ... ${Math.round(f * 100)}%`, 0.02 + f * 0.6));
        say('Audio ready.', 1);
      } else {
        const audio = await engine.render(mode, store.ui.pattern, 44100, (f) => say(`Preparing sounds ... ${Math.round(f * 100)}%`, 0.02 * f));
        say('Encoding video ...', 0.05);
        const { encodeMp4 } = await import('./video.js');
        bytes = await encodeMp4(audio, {
          layout,
          title: name,
          subtitle: `${store.project.bpm} BPM • every sound made from a math formula`,
          onProgress: (f) => say(`Encoding video ... ${Math.round(f * 100)}%`, 0.05 + f * 0.95),
          isCancelled: () => cancelled || !document.body.contains(dialog.box),
        });
      }
      if (cancelled || !document.body.contains(dialog.box)) return;
      say(`Done in ${((performance.now() - t0) / 1000).toFixed(1)} s. Choose where to save ...`, 1);
      const ext = format === 'wav' ? 'wav' : 'mp4';
      const path = await saveBytes(bytes, { defaultName: `${name}.${ext}`, filterName: format === 'wav' ? 'WAV audio' : 'MP4 video', extensions: [ext] });
      if (path) {
        toast(`Saved ${path}`, 'ok', 6000);
        statusHint.textContent = `Exported ${path}`;
      }
      dialog.close();
    } catch (err) {
      if (!cancelled) say(`Export failed: ${err.message || err}`);
      exportBtn.disabled = false;
    } finally {
      exporting = false;
    }
  }
}

function openAiSettings() {
  const s = loadSettings();
  const provider = h('select', {}, Object.entries(PROVIDERS).map(([id, p]) => h('option', { value: id }, p.label)));
  provider.value = s.provider;
  const key = h('input', { type: 'password', value: s.apiKey, placeholder: 'Paste your API key', autocomplete: 'off' });
  const model = h('input', { type: 'text', value: s.model });
  const base = h('input', { type: 'text', value: s.baseUrl });
  provider.onchange = () => { model.value = PROVIDERS[provider.value].model; base.value = PROVIDERS[provider.value].baseUrl; };
  for (const el of [key, model, base]) el.addEventListener('keydown', (e) => e.stopPropagation());
  modal({
    title: 'AI settings',
    body: h('div', { style: { display: 'grid', gap: '10px' } },
      h('label', { class: 'field' }, 'Provider', provider),
      h('label', { class: 'field' }, 'API key', key),
      h('label', { class: 'field' }, 'Model', model),
      h('label', { class: 'field' }, 'API address', base),
      h('p', { class: 'hint' },
        'Free options: a Google Gemini key from Google AI Studio; a Groq key (OpenAI-compatible); or Ollama on this computer ',
        '(address http://localhost:11434/v1, no key). Free limits change, so check the provider\'s page. ',
        'The key is stored only on this computer. Do not share a build of the app that contains your key.')),
    actions: [
      { label: 'Cancel' },
      { label: 'Save', primary: true, run: () => {
        const warning = saveSettings({ provider: provider.value, apiKey: key.value.trim(), model: model.value.trim(), baseUrl: base.value.trim() });
        emit('ai');
        toast(warning ? `Saved. ${warning}` : 'AI settings saved.', warning ? 'bad' : 'ok', warning ? 9000 : 3200);
      } },
    ],
  });
}
$('btn-ai-settings').addEventListener('click', openAiSettings);
$('btn-export').addEventListener('click', () => openExport('wav'));

// ---------- menus ----------
const MENUS = {
  File: () => [
    { label: 'New project', kbd: 'Ctrl+N', run: fileNew },
    { label: 'Open ...', kbd: 'Ctrl+O', run: fileOpen },
    { label: 'Save', kbd: 'Ctrl+S', run: () => fileSave(false) },
    { label: 'Save as ...', kbd: 'Ctrl+Shift+S', run: () => fileSave(true) },
    { sep: true },
    { label: 'Export WAV / MP4 ...', kbd: 'Ctrl+R', run: () => openExport('wav') },
    { label: 'Export MP4 video ...', run: () => openExport('mp4') },
    { sep: true },
    { label: 'Rename project ...', run: async () => {
      const name = await promptText('Project name', store.project.name);
      if (name) update((p) => { p.name = name.slice(0, 60); });
    } },
  ],
  Edit: () => [
    { label: 'Undo', kbd: 'Ctrl+Z', run: undo },
    { label: 'Redo', kbd: 'Ctrl+Y', run: redo },
    { sep: true },
    { label: 'Clear current pattern', run: () => update((p) => { const pat = p.patterns.find((x) => x.id === store.ui.pattern); pat.steps = {}; pat.notes = {}; }, { what: 'steps' }) },
  ],
  View: () => Object.values(views).map((v) => ({ label: v.label, kbd: v.key, run: () => setView(v.id) })),
  Help: () => [
    { label: 'Keyboard shortcuts', run: showShortcuts },
    { label: 'How sounds are verified', run: () => setView('lab') },
  ],
};
for (const [name, items] of Object.entries(MENUS)) {
  const btn = h('button', { class: 'menu-btn' }, name);
  btn.addEventListener('click', () => {
    const r = btn.getBoundingClientRect();
    btn.classList.add('open');
    showMenu(r.left, r.bottom + 2, items(), () => btn.classList.remove('open'));
  });
  $('menus').append(btn);
}

function showShortcuts() {
  const rows = [['Space', 'Play / stop'], ['L', 'Switch pattern / song mode'], ['F4', 'Graph Song (formula graphs heard as pitch)'], ['F5 - F10', 'Playlist, Rack, Piano Roll, Lab, Mixer, AI Composer'],
    ['Ctrl+Z / Ctrl+Y', 'Undo / redo'], ['Ctrl+S', 'Save'], ['Ctrl+O', 'Open'], ['Ctrl+R', 'Export WAV / MP4'], ['Ctrl+Enter', 'Play formula (in the Lab)']];
  modal({ title: 'Keyboard shortcuts', body: h('table', { class: 'data' }, h('tbody', {}, rows.map(([k, d]) => h('tr', {}, h('td', { class: 'num' }, k), h('td', {}, d))))) });
}

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); fileSave(e.shiftKey); return; }
  if (ctrl && e.key.toLowerCase() === 'o') { e.preventDefault(); fileOpen(); return; }
  if (ctrl && e.key.toLowerCase() === 'n') { e.preventDefault(); fileNew(); return; }
  if (ctrl && e.key.toLowerCase() === 'r') { e.preventDefault(); openExport('wav'); return; }
  const fkeys = { F4: 'graph', F5: 'playlist', F6: 'rack', F7: 'pianoroll', F8: 'lab', F9: 'mixer', F10: 'composer' };
  if (fkeys[e.key]) { e.preventDefault(); setView(fkeys[e.key]); return; }
  if (typing) return;
  if (ctrl && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (ctrl && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
  if (e.key.toLowerCase() === 'l' && !ctrl) setMode(store.ui.mode === 'pattern' ? 'song' : 'pattern');
});

// ---------- store wiring ----------
subscribe((what) => {
  if (what === 'mixer' || what === 'all' || what === 'project') {
    engine.sync();
    masterKnob.setValue(store.project.master.volume);
  }
  if (what === 'all' || what === 'project' || what === 'selection') renderPatternPicker();
  if (what === 'all' || what === 'tempo') { refreshTransport(); engine.retime(); }
  for (const v of Object.values(views)) v.onChange?.(what);
  title();
});

// ---------- animation loop: playhead, meters, scope ----------
const scope = $('scope');
const scopeCtx = scope.getContext('2d');
const scopeBuf = new Float32Array(2048);
const meterBars = $('master-meter').querySelectorAll('i');
let lastStep = -1;

function frame() {
  if (engine.playing) {
    const pos = engine.position();
    const step = Math.floor(pos);
    if (step !== lastStep) {
      const bar = Math.floor(step / STEPS_PER_BAR) + 1, beat = Math.floor((step % STEPS_PER_BAR) / 4) + 1, s = (step % 4) + 1;
      timeLcd.lastChild.textContent = `${bar}:${beat}:${String(s).padStart(2, '0')}`;
      lastStep = step;
    }
    const patternMode = engine.mode === 'pattern';
    if (patternMode) {
      views.rack.tick(step);
      if (store.ui.view === 'pianoroll') views.pianoroll.tick(pos);
    } else if (store.ui.view === 'playlist') views.playlist.tick(pos);
  }
  const levels = engine.meters();
  if (levels) {
    const pct = Math.min(100, (levels.master / 1.12) * 100);
    meterBars.forEach((b) => { b.style.clipPath = `inset(${100 - pct}% 0 0 0)`; });
    if (store.ui.view === 'mixer') views.mixer.meters(levels);
  }
  scopeCtx.fillStyle = '#14171a';
  scopeCtx.fillRect(0, 0, scope.width, scope.height);
  if (engine.scope(scopeBuf)) {
    scopeCtx.beginPath();
    for (let x = 0; x < scope.width; x++) {
      const y = scope.height / 2 - scopeBuf[Math.floor((x / scope.width) * 1024)] * (scope.height / 2 - 2);
      if (x) scopeCtx.lineTo(x, y); else scopeCtx.moveTo(x, y);
    }
    scopeCtx.strokeStyle = '#f29b38';
    scopeCtx.lineWidth = 1;
    scopeCtx.stroke();
  }
  requestAnimationFrame(frame);
}

// ---------- start ----------
renderBrowser();
const restored = restoreAutosave();
views.mixer.init();
renderPatternPicker();
refreshTransport();
emit('all');
setView('rack');
title();
$('status-info').textContent = `${isDesktop ? 'Desktop' : 'Browser'} • ${LIBRARY.length} formula instruments • autosave on`;
statusHint.textContent = restored ? 'Restored your last session.' : 'Welcome to Quest Studio. Paint steps, press Space to play.';
requestAnimationFrame(frame);
