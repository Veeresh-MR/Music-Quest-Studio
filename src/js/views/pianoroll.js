// Piano Roll: draw notes for the selected channel in the current pattern.
import { h, fitCanvas, noteName, isBlackKey, cssVar, clamp } from '../util.js';
import { store, update, currentPattern, currentChannel, STEPS_PER_BAR } from '../project.js';

const KEY_W = 58, RULER_H = 22, ROW_H = 15;
const LOW = 21, HIGH = 108; // A0 .. C8

export function createPianoRoll(app) {
  const canvas = h('canvas', { tabIndex: 0 });
  const wrap = h('div', { class: 'view-body', style: { overflow: 'hidden' } }, canvas);
  const channelSelect = h('select', { title: 'Channel', onchange: () => app.selectChannel(channelSelect.value) });
  const lenSelect = h('select', { title: 'New note length' },
    [[1, '1/16'], [2, '1/8'], [4, '1/4'], [8, '1/2'], [16, '1 bar']].map(([v, l]) => h('option', { value: v }, l)));
  lenSelect.value = '2';
  const root = h('div', { class: 'view', id: 'view-pianoroll' },
    h('div', { class: 'view-bar' },
      h('span', { class: 'title' }, 'Piano Roll'),
      channelSelect,
      h('label', { class: 'hint' }, 'New note ', lenSelect),
      h('button', { class: 'btn small', onclick: () => zoom(1.25) }, 'Zoom +'),
      h('button', { class: 'btn small', onclick: () => zoom(0.8) }, 'Zoom −'),
      h('button', { class: 'btn small', onclick: clearNotes }, 'Clear notes'),
      h('span', { class: 'hint' }, 'Click to add, drag to move, drag the right edge to resize, right-click to delete. Wheel scrolls, Shift+wheel scrolls sideways, Ctrl+wheel zooms.')),
    wrap);

  let stepW = 24;
  let scrollX = 0;
  let scrollY = (HIGH - 72) * ROW_H; // start around C5
  let drag = null;
  let hover = null;
  let playStep = -1;
  let dragId = 0;
  let size = { w: 0, h: 0 };

  const notes = () => currentPattern().notes[store.ui.channel] || [];
  const totalSteps = () => currentPattern().bars * STEPS_PER_BAR;
  const keyAt = (y) => HIGH - Math.floor((y - RULER_H + scrollY) / ROW_H);
  const stepAt = (x) => Math.floor((x - KEY_W + scrollX) / stepW);
  const xOf = (step) => KEY_W + step * stepW - scrollX;
  const yOf = (key) => RULER_H + (HIGH - key) * ROW_H - scrollY;

  function zoom(f) {
    stepW = clamp(stepW * f, 8, 80);
    draw();
  }

  function clearNotes() {
    update((p) => { delete p.patterns.find((x) => x.id === store.ui.pattern).notes[store.ui.channel]; }, { what: 'steps' });
  }

  function hit(x, y) {
    const list = notes();
    for (let i = list.length - 1; i >= 0; i--) {
      const n = list[i];
      const x0 = xOf(n.step), x1 = xOf(n.step + n.len), y0 = yOf(n.key);
      if (x >= x0 && x <= x1 && y >= y0 && y < y0 + ROW_H) return { index: i, note: n, edge: x1 - x <= 6 };
    }
    return null;
  }

  function editNotes(fn) {
    update((p) => {
      const pat = p.patterns.find((x) => x.id === store.ui.pattern);
      pat.notes[store.ui.channel] = pat.notes[store.ui.channel] || [];
      fn(pat.notes[store.ui.channel], pat);
    }, { what: 'steps', coalesce: `pr${dragId}` });
  }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    canvas.focus();
    const ch = currentChannel();
    if (!ch) return;
    const { offsetX: x, offsetY: y } = e;
    if (y < RULER_H) return;
    const key = keyAt(y);
    if (x < KEY_W) { if (key >= LOW && key <= HIGH) app.engine.preview(ch, key, 4); return; }
    const found = hit(x, y);
    dragId++;
    if (e.button === 2) {
      if (found) editNotes((list) => list.splice(found.index, 1));
      return;
    }
    if (e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    const step = stepAt(x);
    if (found) {
      drag = { index: found.index, mode: found.edge ? 'resize' : 'move', grabStep: step - found.note.step, startKey: found.note.key };
      lenSelect.value = String(found.note.len);
      if (!found.edge) app.engine.preview(ch, found.note.key, found.note.len);
    } else {
      if (step < 0 || step >= totalSteps() || key < LOW || key > HIGH) return;
      const len = Math.min(+lenSelect.value, totalSteps() - step);
      editNotes((list) => list.push({ step, len, key, vel: 0.8 }));
      drag = { index: notes().length - 1, mode: 'move', grabStep: 0, startKey: key };
      app.engine.preview(ch, key, len);
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const { offsetX: x, offsetY: y } = e;
    if (!drag) {
      const found = y > RULER_H && x > KEY_W ? hit(x, y) : null;
      canvas.style.cursor = found ? (found.edge ? 'ew-resize' : 'grab') : 'default';
      const k = y > RULER_H ? keyAt(y) : null;
      if (k !== hover) { hover = k; draw(); }
      return;
    }
    const n = notes()[drag.index];
    if (!n) return;
    const total = totalSteps();
    if (drag.mode === 'resize') {
      const len = clamp(stepAt(x) - n.step + 1, 1, total - n.step);
      if (len !== n.len) { editNotes((list) => { list[drag.index].len = len; }); lenSelect.value = String(len); }
    } else {
      const step = clamp(stepAt(x) - drag.grabStep, 0, total - n.len);
      const key = clamp(keyAt(y), LOW, HIGH);
      if (step !== n.step || key !== n.key) {
        editNotes((list) => { list[drag.index].step = step; list[drag.index].key = key; });
        if (key !== drag.startKey) { drag.startKey = key; app.engine.preview(currentChannel(), key, n.len); }
      }
    }
  });

  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('pointerleave', () => { if (hover !== null) { hover = null; draw(); } });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey) zoom(e.deltaY < 0 ? 1.1 : 0.9);
    else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) scrollX = clamp(scrollX + (e.deltaX || e.deltaY), 0, Math.max(0, totalSteps() * stepW - (size.w - KEY_W) + 40));
    else scrollY = clamp(scrollY + e.deltaY, 0, Math.max(0, (HIGH - LOW + 1) * ROW_H - (size.h - RULER_H)));
    draw();
  }, { passive: false });

  new ResizeObserver(() => draw()).observe(wrap);

  function draw() {
    if (!root.classList.contains('on')) return;
    const w = wrap.clientWidth, hgt = wrap.clientHeight;
    size = { w, h: hgt };
    const ctx = fitCanvas(canvas, w, hgt);
    const pat = currentPattern();
    const ch = currentChannel();
    const total = totalSteps();
    const bg = cssVar('--panel-2'), deep = cssVar('--bg-deep'), line = cssVar('--line');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, hgt);

    // rows
    for (let key = HIGH; key >= LOW; key--) {
      const y = yOf(key);
      if (y > hgt || y + ROW_H < RULER_H) continue;
      ctx.fillStyle = isBlackKey(key) ? '#262b31' : '#2e343b';
      ctx.fillRect(KEY_W, y, w, ROW_H);
      ctx.fillStyle = key % 12 === 0 ? '#1d2125' : '#283036';
      ctx.fillRect(KEY_W, y + ROW_H - 1, w, 1);
    }
    // vertical grid
    for (let s = 0; s <= total; s++) {
      const x = xOf(s);
      if (x < KEY_W || x > w) continue;
      ctx.fillStyle = s % STEPS_PER_BAR === 0 ? '#14171a' : s % 4 === 0 ? '#20262b' : '#2a3137';
      ctx.fillRect(x, RULER_H, 1, hgt);
    }
    // area past the pattern end
    const endX = xOf(total);
    if (endX < w) { ctx.fillStyle = 'rgba(10,12,14,0.55)'; ctx.fillRect(Math.max(KEY_W, endX), RULER_H, w, hgt); }

    // ghost notes of other channels
    for (const other of store.project.channels) {
      if (other.id === ch?.id) continue;
      for (const n of pat.notes[other.id] || []) {
        ctx.fillStyle = 'rgba(214,220,226,0.10)';
        ctx.fillRect(xOf(n.step) + 1, yOf(n.key) + 2, n.len * stepW - 2, ROW_H - 4);
      }
    }
    // notes
    ctx.font = `10px ${cssVar('--ui')}`;
    for (const n of notes()) {
      const x = xOf(n.step), y = yOf(n.key), nw = n.len * stepW;
      if (x > w || x + nw < KEY_W || y > hgt || y + ROW_H < RULER_H) continue;
      ctx.fillStyle = ch?.color || cssVar('--note');
      ctx.globalAlpha = 0.35 + n.vel * 0.65;
      roundRect(ctx, x + 1, y + 1, nw - 2, ROW_H - 2, 3);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.stroke();
      if (nw > 30) {
        ctx.fillStyle = 'rgba(10,14,12,0.85)';
        ctx.fillText(noteName(n.key), x + 5, y + ROW_H - 4);
      }
    }
    // playhead
    if (playStep >= 0) {
      const x = xOf(playStep);
      if (x >= KEY_W) { ctx.fillStyle = cssVar('--accent'); ctx.fillRect(x, RULER_H, 2, hgt); }
    }

    // keyboard
    ctx.fillStyle = deep;
    ctx.fillRect(0, RULER_H, KEY_W, hgt);
    for (let key = HIGH; key >= LOW; key--) {
      const y = yOf(key);
      if (y > hgt || y + ROW_H < RULER_H) continue;
      const black = isBlackKey(key);
      ctx.fillStyle = key === hover ? cssVar('--accent') : black ? '#1c1f22' : '#cfd5da';
      ctx.fillRect(0, y, black ? KEY_W * 0.62 : KEY_W - 1, ROW_H - 1);
      if (key % 12 === 0) {
        ctx.fillStyle = key === hover ? '#1b1f23' : '#4a5560';
        ctx.fillText(noteName(key), KEY_W - 26, y + ROW_H - 4);
      }
    }
    // ruler
    ctx.fillStyle = deep;
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.fillStyle = line;
    ctx.fillRect(0, RULER_H - 1, w, 1);
    ctx.fillStyle = cssVar('--text-dim');
    for (let bar = 0; bar < total / STEPS_PER_BAR; bar++) {
      const x = xOf(bar * STEPS_PER_BAR);
      if (x < KEY_W - 1 || x > w) continue;
      ctx.fillText(String(bar + 1), x + 4, 15);
      for (let b = 1; b < 4; b++) {
        const bx = xOf(bar * STEPS_PER_BAR + b * 4);
        ctx.fillRect(bx, RULER_H - 6, 1, 5);
      }
    }
    ctx.fillStyle = cssVar('--text-faint');
    ctx.fillText(ch ? ch.name : 'No channel', 6, 15);
  }

  function renderBar() {
    channelSelect.replaceChildren(...store.project.channels.map((c) => h('option', { value: c.id }, c.name)));
    channelSelect.value = store.ui.channel;
  }

  return {
    id: 'pianoroll', label: 'Piano Roll', key: 'F7', root,
    onChange(what) {
      if (what === 'all' || what === 'project' || what === 'selection') renderBar();
      if (what !== 'mixer' && what !== 'tempo') draw();
    },
    onShow() { renderBar(); draw(); },
    tick(step) {
      if (step !== playStep) { playStep = step; draw(); }
    },
    clearTick() { if (playStep !== -1) { playStep = -1; draw(); } },
  };
}

export function roundRect(ctx, x, y, w, hgt, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + hgt, r);
  ctx.arcTo(x + w, y + hgt, x, y + hgt, r);
  ctx.arcTo(x, y + hgt, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
