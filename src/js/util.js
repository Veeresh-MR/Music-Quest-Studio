// Small DOM and math helpers shared by the views.

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const uid = (prefix = 'id') => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (key) => `${NAMES[((key % 12) + 12) % 12]}${Math.floor(key / 12) - 1}`;
export const isBlackKey = (key) => [1, 3, 6, 8, 10].includes(((key % 12) + 12) % 12);

export function debounce(fn, ms) {
  let id;
  return (...args) => {
    clearTimeout(id);
    id = setTimeout(() => fn(...args), ms);
  };
}

// Canvas sized for the device pixel ratio; returns a 2D context in CSS pixels.
export function fitCanvas(canvas, width, height) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.floor(width)), hgt = Math.max(1, Math.floor(height));
  if (canvas.width !== w * dpr || canvas.height !== hgt * dpr) {
    canvas.width = w * dpr;
    canvas.height = hgt * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${hgt}px`;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Rotary knob: drag up/down, mouse wheel, double-click resets.
export function knob({ value, min = 0, max = 1, def = value, size = 22, title = '', format = (v) => v.toFixed(2), onInput, bipolar = false }) {
  const el = h('div', { class: 'knob', title, tabIndex: 0, style: { width: `${size}px`, height: `${size}px` } });
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const track = document.createElementNS(svgNS, 'path');
  const arc = document.createElementNS(svgNS, 'path');
  const dot = document.createElementNS(svgNS, 'line');
  track.setAttribute('class', 'knob-track');
  arc.setAttribute('class', 'knob-arc');
  dot.setAttribute('class', 'knob-dot');
  svg.append(track, arc, dot);
  el.append(svg);
  const A0 = -135, A1 = 135;
  const point = (deg, r = 9) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return [12 + r * Math.cos(a), 12 + r * Math.sin(a)];
  };
  const arcPath = (from, to) => {
    const [x1, y1] = point(from), [x2, y2] = point(to);
    const large = Math.abs(to - from) > 180 ? 1 : 0;
    const sweep = to > from ? 1 : 0;
    return `M ${x1} ${y1} A 9 9 0 ${large} ${sweep} ${x2} ${y2}`;
  };
  track.setAttribute('d', arcPath(A0, A1));
  let current = value;
  const draw = () => {
    const p = (current - min) / (max - min);
    const deg = A0 + p * (A1 - A0);
    const origin = bipolar ? 0 : A0;
    arc.setAttribute('d', Math.abs(deg - origin) < 0.5 ? '' : arcPath(Math.min(origin, deg), Math.max(origin, deg)));
    const [x1, y1] = point(deg, 3), [x2, y2] = point(deg, 8);
    dot.setAttribute('x1', x1); dot.setAttribute('y1', y1); dot.setAttribute('x2', x2); dot.setAttribute('y2', y2);
    el.title = `${title}: ${format(current)}`;
  };
  const set = (v, emit = true) => {
    current = clamp(v, min, max);
    draw();
    if (emit) onInput?.(current);
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const startY = e.clientY, startV = current;
    const move = (ev) => set(startV + ((startY - ev.clientY) / (ev.shiftKey ? 600 : 150)) * (max - min));
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  });
  el.addEventListener('wheel', (e) => { e.preventDefault(); set(current - Math.sign(e.deltaY) * (max - min) / 50); }, { passive: false });
  el.addEventListener('dblclick', () => set(def));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); set(current + (max - min) / 50); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); set(current - (max - min) / 50); }
  });
  draw();
  el.setValue = (v) => set(v, false);
  return el;
}

export function toast(message, kind = 'info', ms = 3200) {
  let host = document.getElementById('toasts');
  if (!host) {
    host = h('div', { id: 'toasts' });
    document.body.append(host);
  }
  const el = h('div', { class: `toast toast-${kind}`, role: 'status' }, message);
  host.append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 250);
  }, ms);
}

export function modal({ title, body, actions = [] }) {
  const close = () => {
    back.classList.add('out');
    setTimeout(() => back.remove(), 160);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const box = h('div', { class: 'modal', role: 'dialog', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('span', {}, title), h('button', { class: 'icon-btn', title: 'Close', onclick: close }, '✕')),
    h('div', { class: 'modal-body' }, body),
    actions.length ? h('div', { class: 'modal-foot' }, actions.map((a) =>
      h('button', { class: a.primary ? 'btn primary' : 'btn', onclick: async () => { if ((await a.run?.()) !== false) close(); } }, a.label))) : null);
  const back = h('div', { class: 'modal-back', onmousedown: (e) => { if (e.target === back) close(); } }, box);
  document.body.append(back);
  document.addEventListener('keydown', onKey);
  return { close, box };
}
