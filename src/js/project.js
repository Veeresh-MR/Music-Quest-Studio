// Project data model, validation, undo/redo and autosave.
import { check } from './formula.js';
import { LIBRARY } from './synth.js';
import { uid, clamp } from './util.js';

export const STEPS_PER_BAR = 16;
export const MAX_TRACKS = 16;
export const MAX_BARS = 256;
const AUTOSAVE_KEY = 'quest.autosave.v1';

const PATTERN_COLORS = ['#5aa9e6', '#7bd389', '#f6c85f', '#e8743b', '#d873c9', '#6fd6c6', '#b39ddb', '#ef8a8a'];

export function channelFromLibrary(name) {
  const item = LIBRARY.find((i) => i.name === name);
  if (!item) throw new Error(`Unknown instrument ${name}`);
  return makeChannel(item);
}

export function makeChannel({ name, formula, mode = 'note', length = 1, release = 0.1, color = '#7bd389' }) {
  return { id: uid('ch'), name, formula, mode, length, release, color, volume: 0.8, pan: 0, mute: false, solo: false };
}

export function makePattern(index) {
  return { id: uid('pt'), name: `Pattern ${index}`, bars: 1, color: PATTERN_COLORS[(index - 1) % PATTERN_COLORS.length], steps: {}, notes: {} };
}

export function newProject() {
  const channels = ['Kick', 'Clap', 'Closed Hat', '808 Glide', 'Piano'].map(channelFromLibrary);
  return {
    version: 1,
    name: 'Untitled',
    bpm: 130,
    channels,
    patterns: [makePattern(1)],
    playlist: [],
    master: { volume: 0.85, reverb: 0.15, limiter: true },
    graph: { bars: 4, bpm: 120, layers: [] },
  };
}

// Graph Song (formula graphs heard as pitch). Untrusted input is validated like channels.
function normalizeGraph(raw, problems) {
  const layers = [];
  for (const l of Array.isArray(raw?.layers) ? raw.layers.slice(0, 8) : []) {
    const formula = String(l?.formula ?? '');
    const err = check(formula);
    if (err) { problems.push(`Graph layer "${l?.name}": ${err.message}`); continue; }
    layers.push({
      id: typeof l.id === 'string' && l.id ? l.id : uid('gl'),
      name: String(l.name || 'Layer').slice(0, 30),
      formula,
      key: Math.round(num(l.key, 24, 96, 57)),
      volume: num(l.volume, 0, 1, 0.5),
      wave: ['sine', 'warm', 'square'].includes(l.wave) ? l.wave : 'sine',
      mute: !!l.mute,
    });
  }
  return { bars: Math.round(num(raw?.bars, 1, 32, 4)), bpm: Math.round(num(raw?.bpm, 40, 240, 120)), layers };
}

const num = (x, lo, hi, def) => (Number.isFinite(+x) ? clamp(+x, lo, hi) : def);

// Accepts untrusted JSON (opened file or AI output) and returns a safe project, plus problems found.
export function normalizeProject(raw) {
  const problems = [];
  if (!raw || typeof raw !== 'object') throw new Error('Not a Quest Studio project file.');
  const channels = [];
  for (const c of Array.isArray(raw.channels) ? raw.channels.slice(0, 64) : []) {
    const formula = String(c?.formula ?? '');
    const err = check(formula);
    if (err) { problems.push(`Channel "${c?.name}": ${err.message}`); continue; }
    channels.push({
      id: typeof c.id === 'string' && c.id ? c.id : uid('ch'),
      name: String(c.name || 'Channel').slice(0, 40),
      formula,
      mode: c.mode === 'oneshot' ? 'oneshot' : 'note',
      length: num(c.length, 0.02, 12, 1),
      release: num(c.release, 0, 4, 0.1),
      color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : '#7bd389',
      volume: num(c.volume, 0, 1.25, 0.8),
      pan: num(c.pan, -1, 1, 0),
      mute: !!c.mute,
      solo: !!c.solo,
    });
  }
  const ids = new Set(channels.map((c) => c.id));
  const patterns = [];
  for (const [i, p] of (Array.isArray(raw.patterns) ? raw.patterns.slice(0, 99) : []).entries()) {
    const bars = Math.round(num(p?.bars, 1, 8, 1));
    const total = bars * STEPS_PER_BAR;
    const steps = {}, notes = {};
    for (const [ch, list] of Object.entries(p?.steps || {})) {
      if (!ids.has(ch) || !Array.isArray(list)) continue;
      steps[ch] = [...new Set(list.map((s) => Math.round(+s)).filter((s) => s >= 0 && s < total))].sort((a, b) => a - b);
    }
    for (const [ch, list] of Object.entries(p?.notes || {})) {
      if (!ids.has(ch) || !Array.isArray(list)) continue;
      notes[ch] = list.slice(0, 2000).map((n) => ({
        step: Math.round(num(n?.step, 0, total - 1, 0)),
        len: Math.round(num(n?.len, 1, total, 1)),
        key: Math.round(num(n?.key, 12, 120, 60)),
        vel: num(n?.vel, 0.05, 1, 0.8),
      })).map((n) => ({ ...n, len: Math.min(n.len, total - n.step) }));
    }
    patterns.push({
      id: typeof p.id === 'string' && p.id ? p.id : uid('pt'),
      name: String(p.name || `Pattern ${i + 1}`).slice(0, 40),
      bars,
      color: /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : PATTERN_COLORS[i % PATTERN_COLORS.length],
      steps, notes,
    });
  }
  if (!patterns.length) patterns.push(makePattern(1));
  const pids = new Set(patterns.map((p) => p.id));
  const playlist = (Array.isArray(raw.playlist) ? raw.playlist.slice(0, 2000) : [])
    .filter((c) => pids.has(c?.pattern))
    .map((c) => ({
      id: typeof c.id === 'string' && c.id ? c.id : uid('cl'),
      pattern: c.pattern,
      track: Math.round(num(c.track, 0, MAX_TRACKS - 1, 0)),
      bar: Math.round(num(c.bar, 0, MAX_BARS - 1, 0)),
    }));
  const m = raw.master || {};
  return {
    project: {
      version: 1,
      name: String(raw.name || 'Untitled').slice(0, 60),
      bpm: Math.round(num(raw.bpm, 40, 240, 130)),
      channels, patterns, playlist,
      master: { volume: num(m.volume, 0, 1.25, 0.85), reverb: num(m.reverb, 0, 1, 0.15), limiter: m.limiter !== false },
      graph: normalizeGraph(raw.graph, problems),
    },
    problems,
  };
}

export const songLengthBars = (project) => {
  let end = 0;
  for (const clip of project.playlist) {
    const p = project.patterns.find((x) => x.id === clip.pattern);
    if (p) end = Math.max(end, clip.bar + p.bars);
  }
  return end;
};

// ---- store with undo/redo ----
const listeners = new Set();
const undoStack = [], redoStack = [];

export const store = {
  project: newProject(),
  ui: { channel: null, pattern: null, view: 'rack', mode: 'pattern' },
  dirty: false,
  filePath: null,
};
store.ui.channel = store.project.channels[0].id;
store.ui.pattern = store.project.patterns[0].id;

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(what = 'project') {
  for (const fn of listeners) fn(what);
}

let saveTimer;
function autosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(store.project)); } catch { /* storage full or blocked */ }
  }, 400);
}

// All edits go through here so undo, redraw and autosave stay consistent.
// `coalesce` merges rapid edits of the same control (knob drags) into one undo step.
let lastCoalesce = null, lastTime = 0;
export function update(mutate, { what = 'project', coalesce = null } = {}) {
  const now = performance.now();
  if (!(coalesce && coalesce === lastCoalesce && now - lastTime < 800)) {
    undoStack.push(JSON.stringify(store.project));
    if (undoStack.length > 150) undoStack.shift();
    redoStack.length = 0;
  }
  lastCoalesce = coalesce;
  lastTime = now;
  mutate(store.project);
  store.dirty = true;
  autosave();
  emit(what);
}

function restore(json) {
  store.project = JSON.parse(json);
  fixSelection();
  store.dirty = true;
  autosave();
  emit('all');
}

export function undo() {
  if (!undoStack.length) return false;
  redoStack.push(JSON.stringify(store.project));
  restore(undoStack.pop());
  lastCoalesce = null;
  return true;
}

export function redo() {
  if (!redoStack.length) return false;
  undoStack.push(JSON.stringify(store.project));
  restore(redoStack.pop());
  lastCoalesce = null;
  return true;
}

export function fixSelection() {
  const p = store.project;
  if (!p.channels.some((c) => c.id === store.ui.channel)) store.ui.channel = p.channels[0]?.id ?? null;
  if (!p.patterns.some((x) => x.id === store.ui.pattern)) store.ui.pattern = p.patterns[0].id;
}

export function loadProject(project, filePath = null) {
  undoStack.length = 0;
  redoStack.length = 0;
  store.project = project;
  store.filePath = filePath;
  store.dirty = false;
  fixSelection();
  autosave();
  emit('all');
}

export function restoreAutosave() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return false;
    const { project } = normalizeProject(JSON.parse(raw));
    loadProject(project);
    return true;
  } catch {
    return false;
  }
}

export const currentPattern = () => store.project.patterns.find((p) => p.id === store.ui.pattern);
export const currentChannel = () => store.project.channels.find((c) => c.id === store.ui.channel);
