// Playlist: arrange pattern clips on tracks to build the song.
import { h, fitCanvas, cssVar, clamp, uid } from '../util.js';
import { store, update, emit, songLengthBars, STEPS_PER_BAR, MAX_TRACKS, MAX_BARS } from '../project.js';
import { roundRect } from './pianoroll.js';

const HEAD_W = 96, RULER_H = 24, TRACK_H = 42;

export function createPlaylist(app) {
  const canvas = h('canvas', { tabIndex: 0 });
  const wrap = h('div', { class: 'view-body', style: { overflow: 'hidden' } }, canvas);
  const lengthLabel = h('span', { class: 'hint' });
  const root = h('div', { class: 'view', id: 'view-playlist' },
    h('div', { class: 'view-bar' },
      h('span', { class: 'title' }, 'Playlist'),
      h('button', { class: 'btn small', onclick: () => zoom(1.25) }, 'Zoom +'),
      h('button', { class: 'btn small', onclick: () => zoom(0.8) }, 'Zoom −'),
      lengthLabel,
      h('span', { class: 'hint' }, 'Click an empty spot to place the selected pattern. Drag to move, right-click to delete, double-click to edit. Click the ruler to start from there.')),
    wrap);

  let barW = 56, scrollX = 0, scrollY = 0;
  let drag = null, playStep = -1, dragId = 0;
  let size = { w: 0, h: 0 };

  const patternOf = (clip) => store.project.patterns.find((p) => p.id === clip.pattern);
  const xOfBar = (bar) => HEAD_W + bar * barW - scrollX;
  const yOfTrack = (t) => RULER_H + t * TRACK_H - scrollY;
  const barAt = (x) => Math.floor((x - HEAD_W + scrollX) / barW);
  const trackAt = (y) => Math.floor((y - RULER_H + scrollY) / TRACK_H);

  function zoom(f) {
    barW = clamp(barW * f, 16, 200);
    draw();
  }

  function hit(x, y) {
    const clips = store.project.playlist;
    for (let i = clips.length - 1; i >= 0; i--) {
      const c = clips[i], p = patternOf(c);
      if (!p) continue;
      const x0 = xOfBar(c.bar), y0 = yOfTrack(c.track);
      if (x >= x0 && x < x0 + p.bars * barW && y >= y0 && y < y0 + TRACK_H) return { clip: c, index: i };
    }
    return null;
  }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    canvas.focus();
    const { offsetX: x, offsetY: y } = e;
    if (y < RULER_H) {
      if (x > HEAD_W) app.playSongFrom(Math.max(0, barAt(x)) * STEPS_PER_BAR);
      return;
    }
    if (x < HEAD_W) return;
    const found = hit(x, y);
    dragId++;
    if (e.button === 2) {
      if (found) update((p) => { p.playlist.splice(found.index, 1); }, { what: 'playlist' });
      return;
    }
    if (e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    if (found) {
      if (store.ui.pattern !== found.clip.pattern) { store.ui.pattern = found.clip.pattern; emit('selection'); }
      drag = { id: found.clip.id, grab: barAt(x) - found.clip.bar };
      return;
    }
    const bar = barAt(x), track = trackAt(y);
    if (bar < 0 || bar >= MAX_BARS || track < 0 || track >= MAX_TRACKS) return;
    const clip = { id: uid('cl'), pattern: store.ui.pattern, track, bar };
    update((p) => { p.playlist.push(clip); }, { what: 'playlist', coalesce: `pl${dragId}` });
    drag = { id: clip.id, grab: 0 };
  });

  canvas.addEventListener('pointermove', (e) => {
    const { offsetX: x, offsetY: y } = e;
    if (!drag) {
      canvas.style.cursor = y < RULER_H && x > HEAD_W ? 'pointer' : hit(x, y) ? 'grab' : 'default';
      return;
    }
    const clip = store.project.playlist.find((c) => c.id === drag.id);
    if (!clip) return;
    const bar = clamp(barAt(x) - drag.grab, 0, MAX_BARS - 1);
    const track = clamp(trackAt(y), 0, MAX_TRACKS - 1);
    if (bar !== clip.bar || track !== clip.track) {
      update((p) => { const c = p.playlist.find((k) => k.id === drag.id); c.bar = bar; c.track = track; }, { what: 'playlist', coalesce: `pl${dragId}` });
    }
  });

  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('dblclick', (e) => {
    const found = hit(e.offsetX, e.offsetY);
    if (found) { store.ui.pattern = found.clip.pattern; emit('selection'); app.setView('rack'); }
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey) zoom(e.deltaY < 0 ? 1.1 : 0.9);
    else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) scrollX = clamp(scrollX + (e.deltaX || e.deltaY), 0, MAX_BARS * barW);
    else scrollY = clamp(scrollY + e.deltaY, 0, Math.max(0, MAX_TRACKS * TRACK_H - (size.h - RULER_H)));
    draw();
  }, { passive: false });

  new ResizeObserver(() => draw()).observe(wrap);

  function drawPreview(ctx, p, x, y, w) {
    const total = p.bars * STEPS_PER_BAR;
    const allNotes = Object.values(p.notes).flat();
    const keys = allNotes.map((n) => n.key);
    const lo = Math.min(...keys, 127), hi = Math.max(...keys, 0);
    ctx.fillStyle = 'rgba(12,16,20,0.75)';
    for (const n of allNotes) {
      const ny = hi === lo ? y + 24 : y + 36 - ((n.key - lo) / (hi - lo)) * 20;
      ctx.fillRect(x + (n.step / total) * w, ny, Math.max(1.5, (n.len / total) * w - 1), 2);
    }
    const rows = Object.values(p.steps).filter((s) => s.length);
    rows.forEach((steps, r) => {
      for (const s of steps) ctx.fillRect(x + (s / total) * w, y + 18 + (r % 5) * 4, Math.max(1.5, w / total - 1), 2);
    });
  }

  function draw() {
    if (!root.classList.contains('on')) return;
    const w = wrap.clientWidth, hgt = wrap.clientHeight;
    size = { w, h: hgt };
    const ctx = fitCanvas(canvas, w, hgt);
    ctx.fillStyle = cssVar('--panel-2');
    ctx.fillRect(0, 0, w, hgt);
    const end = songLengthBars(store.project);

    for (let t = 0; t < MAX_TRACKS; t++) {
      const y = yOfTrack(t);
      if (y > hgt || y + TRACK_H < RULER_H) continue;
      ctx.fillStyle = t % 2 ? '#2a3036' : '#2e343b';
      ctx.fillRect(HEAD_W, y, w, TRACK_H);
      ctx.fillStyle = '#1d2226';
      ctx.fillRect(HEAD_W, y + TRACK_H - 1, w, 1);
    }
    const firstBar = Math.floor(scrollX / barW);
    for (let b = firstBar; b <= firstBar + w / barW + 1; b++) {
      const x = xOfBar(b);
      ctx.fillStyle = b % 4 === 0 ? '#181c20' : '#252b31';
      ctx.fillRect(x, RULER_H, 1, hgt);
    }
    if (end > 0) {
      const ex = xOfBar(end);
      ctx.fillStyle = 'rgba(10,12,14,0.35)';
      if (ex < w) ctx.fillRect(Math.max(HEAD_W, ex), RULER_H, w, hgt);
    }

    ctx.font = `11px ${cssVar('--ui')}`;
    for (const c of store.project.playlist) {
      const p = patternOf(c);
      if (!p) continue;
      const x = xOfBar(c.bar), y = yOfTrack(c.track), cw = p.bars * barW;
      if (x > w || x + cw < HEAD_W || y > hgt || y + TRACK_H < RULER_H) continue;
      const selected = c.pattern === store.ui.pattern;
      ctx.fillStyle = p.color;
      ctx.globalAlpha = selected ? 0.95 : 0.75;
      roundRect(ctx, x + 1, y + 2, cw - 2, TRACK_H - 4, 4);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = selected ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.5)';
      ctx.stroke();
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 1, y + 2, cw - 2, TRACK_H - 4);
      ctx.clip();
      ctx.fillStyle = 'rgba(12,16,20,0.9)';
      ctx.fillText(p.name, x + 6, y + 14);
      drawPreview(ctx, p, x + 4, y, cw - 8);
      ctx.restore();
    }

    if (playStep >= 0) {
      const x = HEAD_W + (playStep / STEPS_PER_BAR) * barW - scrollX;
      if (x >= HEAD_W) { ctx.fillStyle = cssVar('--accent'); ctx.fillRect(x, 0, 2, hgt); }
    }

    // track headers
    ctx.fillStyle = cssVar('--panel');
    ctx.fillRect(0, RULER_H, HEAD_W, hgt);
    for (let t = 0; t < MAX_TRACKS; t++) {
      const y = yOfTrack(t);
      if (y > hgt || y + TRACK_H < RULER_H) continue;
      ctx.fillStyle = '#1d2226';
      ctx.fillRect(0, y + TRACK_H - 1, HEAD_W, 1);
      ctx.fillStyle = cssVar('--text-dim');
      ctx.fillText(`Track ${t + 1}`, 10, y + TRACK_H / 2 + 4);
    }
    ctx.fillStyle = cssVar('--line');
    ctx.fillRect(HEAD_W - 1, RULER_H, 1, hgt);

    // ruler
    ctx.fillStyle = cssVar('--bg-deep');
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.fillStyle = cssVar('--text-dim');
    for (let b = firstBar; b <= firstBar + w / barW + 1; b++) {
      const x = xOfBar(b);
      if (x < HEAD_W) continue;
      if (barW >= 28 || b % 4 === 0) ctx.fillText(String(b + 1), x + 4, 16);
    }
    if (end > 0) {
      const ex = xOfBar(end);
      if (ex >= HEAD_W) { ctx.fillStyle = cssVar('--accent'); ctx.fillRect(ex - 1, 0, 2, RULER_H); }
    }
    ctx.fillStyle = cssVar('--panel');
    ctx.fillRect(0, 0, HEAD_W, RULER_H);
    ctx.fillStyle = cssVar('--text-faint');
    ctx.fillText('SONG', 10, 16);
    lengthLabel.textContent = end ? `Song length: ${end} bars` : 'Song is empty';
  }

  return {
    id: 'playlist', label: 'Playlist', key: 'F5', root,
    onChange(what) { if (what !== 'mixer') draw(); },
    onShow: draw,
    tick(step) { if (step !== playStep) { playStep = step; draw(); } },
    clearTick() { if (playStep !== -1) { playStep = -1; draw(); } },
  };
}
