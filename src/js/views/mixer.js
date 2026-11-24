// Mixer: one strip per channel plus the master bus. Meters read the real audio graph.
import { h, knob } from '../util.js';
import { store, update } from '../project.js';

const toDb = (x) => (x <= 0.00001 ? '-inf' : (20 * Math.log10(x)).toFixed(1));

export function createMixer(app) {
  const body = h('div', { class: 'view-body' });
  const root = h('div', { class: 'view', id: 'view-mixer' },
    h('div', { class: 'view-bar' },
      h('span', { class: 'title' }, 'Mixer'),
      h('span', { class: 'hint' }, 'Faders set channel volume. M mutes, S solos. The master limiter keeps the mix from clipping.')),
    body);

  let strips = new Map();
  let master = null;

  function fader(value, max, onInput) {
    return h('input', { type: 'range', min: 0, max, step: 0.001, value, title: 'Volume', oninput: (e) => onInput(+e.target.value) });
  }

  function channelStrip(ch) {
    const setCh = (fn, key) => update((p) => fn(p.channels.find((c) => c.id === ch.id)), { what: 'mixer', coalesce: key });
    const meter = h('i');
    const db = h('div', { class: 'strip-db' }, '-inf');
    const vol = fader(ch.volume, 1.25, (v) => setCh((c) => { c.volume = v; }, `mvol${ch.id}`));
    const pan = knob({ value: ch.pan, min: -1, max: 1, def: 0, bipolar: true, size: 26, title: 'Pan', format: (v) => (Math.abs(v) < 0.01 ? 'C' : v < 0 ? `${Math.round(-v * 100)}% L` : `${Math.round(v * 100)}% R`),
      onInput: (v) => setCh((c) => { c.pan = v; }, `mpan${ch.id}`) });
    const mute = h('button', { class: `toggle${ch.mute ? ' on' : ''}`, title: 'Mute', onclick: () => setCh((c) => { c.mute = !c.mute; }) }, 'M');
    const solo = h('button', { class: `toggle solo${ch.solo ? ' on' : ''}`, title: 'Solo', onclick: () => setCh((c) => { c.solo = !c.solo; }) }, 'S');
    const el = h('div', { class: 'strip', style: { '--c': ch.color } },
      h('div', { class: 'strip-name', title: ch.name, style: { borderBottomColor: ch.color }, onclick: () => app.selectChannel(ch.id) }, ch.name),
      pan,
      h('div', { class: 'strip-fader' }, vol, h('div', { class: 'strip-meter' }, meter)),
      db,
      h('div', { class: 'strip-btns' }, mute, solo));
    strips.set(ch.id, { el, meter, db, vol, pan, mute, solo });
    return el;
  }

  function masterStrip() {
    const m = store.project.master;
    const setM = (fn, key) => update((p) => fn(p.master), { what: 'mixer', coalesce: key });
    const meterL = h('i');
    const db = h('div', { class: 'strip-db' }, '-inf');
    const vol = fader(m.volume, 1.25, (v) => setM((x) => { x.volume = v; }, 'mmaster'));
    const reverb = knob({ value: m.reverb, min: 0, max: 1, def: 0.15, size: 26, title: 'Reverb', format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => setM((x) => { x.reverb = v; }, 'mrev') });
    const limiter = h('button', { class: `toggle${m.limiter ? ' on' : ''}`, title: 'Limiter (prevents clipping)', onclick: () => setM((x) => { x.limiter = !x.limiter; }) }, 'LIM');
    const el = h('div', { class: 'strip master' },
      h('div', { class: 'strip-name' }, 'Master'),
      h('div', { class: 'row', style: { alignItems: 'center', gap: '4px' } }, reverb, h('span', { class: 'muted', style: { fontSize: '10px' } }, 'REV')),
      h('div', { class: 'strip-fader' }, vol, h('div', { class: 'strip-meter' }, meterL)),
      db,
      h('div', { class: 'strip-btns' }, limiter));
    master = { el, meter: meterL, db, vol, reverb, limiter };
    return el;
  }

  function render() {
    strips = new Map();
    body.replaceChildren(h('div', { class: 'mixer' }, masterStrip(), store.project.channels.map(channelStrip)));
  }

  function refresh() {
    for (const ch of store.project.channels) {
      const s = strips.get(ch.id);
      if (!s) return render();
      if (document.activeElement !== s.vol) s.vol.value = ch.volume;
      s.pan.setValue(ch.pan);
      s.mute.classList.toggle('on', ch.mute);
      s.solo.classList.toggle('on', ch.solo);
    }
    const m = store.project.master;
    if (document.activeElement !== master.vol) master.vol.value = m.volume;
    master.reverb.setValue(m.reverb);
    master.limiter.classList.toggle('on', m.limiter);
  }

  function setMeter(target, peak) {
    const pct = Math.min(100, (peak / 1.12) * 100);
    target.meter.style.height = `${pct}%`;
    target.meter.style.setProperty('--h', `${target.meter.parentElement.clientHeight}px`);
    target.db.textContent = toDb(peak);
  }

  return {
    id: 'mixer', label: 'Mixer', key: 'F9', root,
    onChange(what) {
      if (what === 'mixer') refresh();
      else if (what === 'all' || what === 'project') render();
    },
    meters(levels) {
      if (!root.classList.contains('on') || !levels) return;
      for (const [id, s] of strips) setMeter(s, levels.channels[id] || 0);
      if (master) setMeter(master, levels.master);
    },
    init: render,
  };
}
