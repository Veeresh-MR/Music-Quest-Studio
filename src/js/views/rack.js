// Channel Rack: one row per channel with mute, pan, volume and a step sequencer for the current pattern.
import { h, knob, fitCanvas, toast } from '../util.js';
import { store, update, currentPattern, makeChannel, STEPS_PER_BAR } from '../project.js';
import { contextMenu, promptText } from './menu.js';

export function createRack(app) {
  const body = h('div', { class: 'view-body' });
  const barsSelect = h('select', { title: 'Pattern length', onchange: () => setBars(+barsSelect.value) },
    [1, 2, 4, 8].map((n) => h('option', { value: n }, `${n} bar${n > 1 ? 's' : ''}`)));
  const root = h('div', { class: 'view', id: 'view-rack' },
    h('div', { class: 'view-bar' },
      h('span', { class: 'title' }, 'Channel Rack'),
      barsSelect,
      h('button', { class: 'btn small', onclick: clearPattern }, 'Clear pattern'),
      h('span', { class: 'hint' }, 'Click or drag steps to paint. Click a name to hear it, double-click to open its formula, right-click for options.')),
    body);

  let rows = new Map(); // channel id -> { led, pan, vol, stepEls }
  let lastNow = -1;
  let painting = null; // true = painting steps on, false = erasing, null = not dragging
  window.addEventListener('pointerup', () => { painting = null; });

  function setBars(bars) {
    update((p) => {
      const pat = p.patterns.find((x) => x.id === store.ui.pattern);
      pat.bars = bars;
      const total = bars * STEPS_PER_BAR;
      for (const id of Object.keys(pat.steps)) pat.steps[id] = pat.steps[id].filter((s) => s < total);
      for (const id of Object.keys(pat.notes)) {
        pat.notes[id] = pat.notes[id].filter((n) => n.step < total).map((n) => ({ ...n, len: Math.min(n.len, total - n.step) }));
      }
    });
  }

  function clearPattern() {
    update((p) => {
      const pat = p.patterns.find((x) => x.id === store.ui.pattern);
      pat.steps = {};
      pat.notes = {};
    }, { what: 'steps' });
  }

  function channelMenu(e, ch) {
    contextMenu(e, [
      { label: 'Open in Formula Lab', run: () => app.openInLab(ch.id) },
      { label: 'Open in Piano Roll', run: () => app.openPianoRoll(ch.id) },
      { label: 'Rename ...', run: async () => {
        const name = await promptText('Rename channel', ch.name);
        if (name) update((p) => { p.channels.find((c) => c.id === ch.id).name = name.slice(0, 40); });
      } },
      { label: ch.mode === 'oneshot' ? 'Switch to note mode (follows pitch)' : 'Switch to one-shot mode (drum)', run: () =>
        update((p) => { const c = p.channels.find((x) => x.id === ch.id); c.mode = c.mode === 'oneshot' ? 'note' : 'oneshot'; }) },
      { label: 'Duplicate', run: () => update((p) => {
        const copy = { ...makeChannel(ch), volume: ch.volume, pan: ch.pan, name: `${ch.name} 2` };
        p.channels.splice(p.channels.findIndex((c) => c.id === ch.id) + 1, 0, copy);
      }) },
      { sep: true },
      { label: 'Delete channel', danger: true, run: () => {
        if (store.project.channels.length <= 1) return toast('A project needs at least one channel.', 'bad');
        update((p) => {
          p.channels = p.channels.filter((c) => c.id !== ch.id);
          for (const pat of p.patterns) { delete pat.steps[ch.id]; delete pat.notes[ch.id]; }
        });
      } },
    ]);
  }

  function miniRoll(ch, pat) {
    const total = pat.bars * STEPS_PER_BAR;
    const width = total * 22 + (total / 4) * 4 - 4;
    const c = h('canvas', { class: 'mini-roll', title: 'Notes in this pattern. Click to edit in the Piano Roll.', onclick: () => app.openPianoRoll(ch.id) });
    requestAnimationFrame(() => {
      const ctx = fitCanvas(c, width, 24);
      const notes = pat.notes[ch.id];
      const keys = notes.map((n) => n.key);
      const lo = Math.min(...keys), hi = Math.max(...keys);
      ctx.fillStyle = ch.color;
      for (const n of notes) {
        const y = hi === lo ? 11 : 19 - ((n.key - lo) / (hi - lo)) * 16;
        ctx.fillRect((n.step / total) * width, y, Math.max(2, (n.len / total) * width - 1), 3);
      }
    });
    return c;
  }

  function render() {
    const pat = currentPattern();
    barsSelect.value = pat.bars;
    const total = pat.bars * STEPS_PER_BAR;
    rows = new Map();

    const list = store.project.channels.map((ch) => {
      const led = h('span', { class: `led${ch.mute ? ' off' : ''}`, title: 'Mute (click)', onclick: () =>
        update((p) => { const c = p.channels.find((x) => x.id === ch.id); c.mute = !c.mute; }, { what: 'mixer' }) });
      const pan = knob({ value: ch.pan, min: -1, max: 1, def: 0, bipolar: true, title: 'Pan', format: (v) => (Math.abs(v) < 0.01 ? 'C' : v < 0 ? `${Math.round(-v * 100)}% L` : `${Math.round(v * 100)}% R`),
        onInput: (v) => update((p) => { p.channels.find((x) => x.id === ch.id).pan = v; }, { what: 'mixer', coalesce: `pan${ch.id}` }) });
      const vol = knob({ value: ch.volume, min: 0, max: 1.25, def: 0.8, title: 'Volume', format: (v) => `${Math.round(v * 100)}%`,
        onInput: (v) => update((p) => { p.channels.find((x) => x.id === ch.id).volume = v; }, { what: 'mixer', coalesce: `vol${ch.id}` }) });
      const name = h('button', {
        class: 'ch-name', title: `${ch.name} - ${ch.mode === 'oneshot' ? 'one-shot' : 'note'} - ${ch.formula}`,
        onclick: () => { app.selectChannel(ch.id); app.engine.preview(ch); },
        ondblclick: () => app.openInLab(ch.id),
        oncontextmenu: (e) => { e.preventDefault(); app.selectChannel(ch.id); channelMenu(e, ch); },
      }, h('i', { class: 'swatch', style: { background: ch.color } }), h('span', {}, ch.name));

      const hasNotes = (pat.notes[ch.id] || []).length > 0;
      const stepEls = [];
      let seq;
      if (hasNotes) {
        seq = miniRoll(ch, pat);
      } else {
        const on = new Set(pat.steps[ch.id] || []);
        const groups = [];
        for (let g = 0; g < total / 4; g++) {
          const group = h('div', { class: 'step-group' });
          for (let i = 0; i < 4; i++) {
            const s = g * 4 + i;
            const el = h('button', {
              class: `step${on.has(s) ? ' on' : ''}`, title: `Step ${s + 1}`, 'aria-pressed': on.has(s) ? 'true' : 'false',
              onpointerdown: (e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                painting = !el.classList.contains('on');
                setStep(ch.id, s, painting, true);
                if (painting) app.engine.preview(ch);
              },
              onpointerenter: () => { if (painting !== null) setStep(ch.id, s, painting, false); },
            });
            stepEls.push(el);
            group.append(el);
          }
          groups.push(group);
        }
        seq = h('div', { class: 'steps' }, groups);
      }
      rows.set(ch.id, { led, pan, vol, stepEls });
      return h('div', { class: `rack-row${ch.id === store.ui.channel ? ' selected' : ''}`, dataset: { id: ch.id } }, led, pan, vol, name, seq);
    });

    body.replaceChildren(h('div', { class: 'rack' }, list,
      h('div', { class: 'rack-add' }, 'Add instruments from the browser on the left, or make one in the Formula Lab.')));
    lastNow = -1;
  }

  let paintStroke = 0;
  function setStep(chId, step, value, newStroke) {
    if (newStroke) paintStroke++;
    update((p) => {
      const pat = p.patterns.find((x) => x.id === store.ui.pattern);
      const set = new Set(pat.steps[chId] || []);
      if (value) set.add(step); else set.delete(step);
      pat.steps[chId] = [...set].sort((a, b) => a - b);
    }, { what: 'steps', coalesce: `paint${paintStroke}` });
  }

  function refreshSteps() {
    const pat = currentPattern();
    for (const [id, row] of rows) {
      const on = new Set(pat.steps[id] || []);
      row.stepEls.forEach((el, i) => {
        el.classList.toggle('on', on.has(i));
        el.setAttribute('aria-pressed', on.has(i) ? 'true' : 'false');
      });
    }
  }

  function refreshMixer() {
    for (const ch of store.project.channels) {
      const row = rows.get(ch.id);
      if (!row) continue;
      row.led.classList.toggle('off', ch.mute);
      row.pan.setValue(ch.pan);
      row.vol.setValue(ch.volume);
    }
  }

  // Lights the column under the playhead.
  function tick(step) {
    if (step === lastNow) return;
    for (const row of rows.values()) {
      row.stepEls[lastNow]?.classList.remove('now');
      row.stepEls[step]?.classList.add('now');
    }
    lastNow = step;
  }

  return {
    id: 'rack', label: 'Channel Rack', key: 'F6', root,
    onChange(what) {
      if (what === 'mixer') refreshMixer();
      else if (what === 'steps') {
        const pat = currentPattern();
        const needsRebuild = store.project.channels.some((c) => (rows.get(c.id)?.stepEls.length === 0) !== ((pat.notes[c.id] || []).length > 0));
        if (needsRebuild) render(); else refreshSteps();
      } else if (what !== 'tempo') render();
    },
    tick,
    clearTick() { tick(-1); },
  };
}
