// AI Composer: a text prompt becomes a full project (instruments as formulas, patterns, arrangement).
import { h, toast } from '../util.js';
import { store, update, loadProject, STEPS_PER_BAR } from '../project.js';
import { generateSong, isConfigured, loadSettings, PROVIDERS, lastModelUsed } from '../ai.js';
import { verifyFormula } from '../verify.js';
import { keyToFreq } from '../synth.js';

const IDEAS = [
  'Dark drift phonk, 140 BPM, heavy 808 glide, cowbell melody in F# minor',
  'Brazilian baile funk, 130 BPM, bouncy kick and claps, short vocal-like synth stabs',
  'Sad lo-fi piano with soft drums and vinyl crackle, 78 BPM, C minor',
  'Happy upbeat pop groove, 118 BPM, bright pluck lead and claps, G major',
  'Calm Indian sitar melody over a warm pad and soft tabla-like hits, raga Yaman feel, 90 BPM',
  'Cinematic strings build with a riser into a big drop, 100 BPM, D minor',
];

export function createComposer(app) {
  const prompt = h('textarea', { placeholder: 'Describe the song: style, mood, tempo, key, instruments ...' });
  prompt.addEventListener('keydown', (e) => e.stopPropagation());
  const genBtn = h('button', { class: 'btn primary', onclick: generate }, 'Compose with AI');
  const status = h('div', { class: 'hint' });
  const preview = h('div');
  const providerLine = h('div', { class: 'hint' });
  let pending = null;

  const root = h('div', { class: 'view', id: 'view-composer' },
    h('div', { class: 'view-bar' },
      h('span', { class: 'title' }, 'AI Composer'),
      h('span', { class: 'hint' }, 'The AI writes every instrument as a formula, plus the notes and arrangement. Everything is checked before it enters your project.')),
    h('div', { class: 'view-body' }, h('div', { class: 'composer' },
      h('div', { class: 'card' },
        h('div', { class: 'card-title' }, 'PROMPT', h('button', { class: 'btn small', onclick: () => app.openAiSettings() }, 'AI settings')),
        prompt,
        h('div', { class: 'chips', style: { marginTop: '8px' } }, IDEAS.map((idea) => h('button', { class: 'chip', onclick: () => { prompt.value = idea; prompt.focus(); } }, idea.split(',')[0]))),
        h('div', { class: 'row', style: { marginTop: '10px', alignItems: 'center' } }, genBtn, providerLine)),
      status,
      preview)));

  function renderProvider() {
    const s = loadSettings();
    providerLine.textContent = isConfigured(s) ? `Using ${PROVIDERS[s.provider].label}, model ${s.model}, address ${s.baseUrl}.` : 'AI is not set up yet: click "AI settings" and paste a free API key.';
  }

  async function generate() {
    const text = prompt.value.trim();
    if (!text) return prompt.focus();
    if (!isConfigured()) { app.openAiSettings(); return; }
    genBtn.disabled = true;
    preview.replaceChildren();
    status.replaceChildren(h('div', { class: 'progress' }, h('i')), h('div', { class: 'hint', style: { marginTop: '6px' } }, 'Starting ...'));
    const say = (msg) => { status.lastChild.textContent = msg; };
    try {
      const { project, problems, key } = await generateSong(text, say);
      say('Verifying every instrument ...');
      await new Promise((r) => setTimeout(r, 0));
      const checks = project.channels.map((ch) => {
        const r = verifyFormula(ch.formula, { f: keyToFreq(57), duration: ch.mode === 'oneshot' ? Math.min(ch.length, 3) : 1.2 });
        return { ch, verdict: r.verdict, peak: r.peak };
      });
      pending = project;
      status.replaceChildren();
      showPreview(project, problems, checks, key);
    } catch (err) {
      status.replaceChildren(h('div', { class: 'verdict fail' }, `AI error: ${err.message || err}`));
    } finally {
      genBtn.disabled = false;
    }
  }

  function showPreview(project, problems, checks, key) {
    const bars = Math.max(0, ...project.playlist.map((c) => c.bar + (project.patterns.find((p) => p.id === c.pattern)?.bars || 0)));
    preview.replaceChildren(h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'RESULT'),
      h('p', { class: 'hint' }, `Composed by ${lastModelUsed}.`),
      h('p', {}, h('b', {}, project.name), ` • ${project.bpm} BPM${key ? ` • ${key}` : ''} • ${project.channels.length} instruments • ${project.patterns.length} patterns • ${bars} bars`),
      h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Instrument'), h('th', {}, 'Formula'), h('th', {}, 'Check'))),
        h('tbody', {}, checks.map(({ ch, verdict, peak }) => h('tr', {},
          h('td', {}, ch.name, h('div', { class: 'muted' }, ch.mode === 'oneshot' ? 'one-shot' : 'note')),
          h('td', { class: 'num', style: { wordBreak: 'break-all' } }, ch.formula),
          h('td', {}, h('span', { class: `badge ${verdict}` }, verdict.toUpperCase()), peak > 1 ? h('div', { class: 'muted' }, 'loud: limiter will act') : null))))),
      problems.length ? h('ul', { class: 'warn-list' }, problems.map((p) => h('li', {}, `Removed: ${p}`))) : null,
      h('div', { class: 'row', style: { marginTop: '10px' } },
        h('button', { class: 'btn primary', onclick: () => apply(true) }, 'Open as new project'),
        h('button', { class: 'btn', onclick: () => apply(false) }, 'Add to current project'))));
  }

  function apply(replace) {
    if (!pending) return;
    const song = pending;
    pending = null;
    if (replace) {
      loadProject(song);
      store.dirty = true;
    } else {
      update((p) => {
        p.channels.push(...song.channels);
        const offset = Math.max(0, ...p.playlist.map((c) => c.bar + (p.patterns.find((x) => x.id === c.pattern)?.bars || 0)));
        p.patterns.push(...song.patterns);
        p.playlist.push(...song.playlist.map((c) => ({ ...c, bar: Math.min(255, c.bar + offset) })));
      });
    }
    store.ui.mode = 'song';
    app.setMode('song');
    app.setView('playlist');
    preview.replaceChildren();
    toast(`Song inserted: ${song.channels.length} instruments, ${song.patterns.length} patterns (${STEPS_PER_BAR} steps per bar).`, 'ok');
  }

  return {
    id: 'composer', label: 'AI Composer', key: 'F10', root,
    onShow: renderProvider,
    onChange(what) { if (what === 'ai') renderProvider(); },
  };
}
