// MP4 export: the rendered song (AAC audio) plus a visualizer video (H.264) drawn from the same audio.
// Encoding uses the system's WebCodecs encoders; mediabunny (MPL-2.0, src/vendor) writes the MP4 file.
import { magnitudeSpectrum } from './verify.js';

export const VIDEO_LAYOUTS = {
  landscape: { label: 'Landscape 1920 × 1080 (YouTube)', width: 1920, height: 1080 },
  vertical: { label: 'Vertical 1080 × 1920 (Reels, Shorts, TikTok)', width: 1080, height: 1920 },
};

const FPS = 30;
const FFT_SIZE = 2048;
const BANDS = 64;

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// Log-spaced frequency bands (40 Hz .. 16 kHz) as FFT bin ranges.
function bandRanges(sampleRate) {
  const binHz = sampleRate / FFT_SIZE;
  const ranges = [];
  for (let b = 0; b < BANDS; b++) {
    const f0 = 40 * Math.pow(16000 / 40, b / BANDS), f1 = 40 * Math.pow(16000 / 40, (b + 1) / BANDS);
    const k0 = Math.max(1, Math.floor(f0 / binHz));
    ranges.push([k0, Math.max(k0 + 1, Math.ceil(f1 / binHz))]);
  }
  return ranges;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

// Everything that never changes (background, glow, brand, title) is drawn once.
function drawStatic(W, H, info) {
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const vertical = H > W;
  const unit = Math.min(W, H) / 1080;
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#1d2228');
  bg.addColorStop(1, '#111417');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const pad = 80 * unit;
  ctx.fillStyle = '#f29b38';
  ctx.font = `700 ${26 * unit}px "Segoe UI", system-ui, sans-serif`;
  ctx.letterSpacing = `${6 * unit}px`;
  ctx.fillText('QUEST STUDIO', pad, pad + 10 * unit);
  ctx.letterSpacing = '0px';

  const titleY = vertical ? H * 0.28 : H * 0.3;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#eef1f4';
  ctx.font = `700 ${(vertical ? 92 : 96) * unit}px "Segoe UI", system-ui, sans-serif`;
  let title = info.title;
  while (ctx.measureText(title).width > W - pad * 2 && title.length > 4) title = `${title.slice(0, -2)}…`;
  ctx.fillText(title, W / 2, titleY);
  ctx.fillStyle = '#9aa5b0';
  ctx.font = `400 ${34 * unit}px "Segoe UI", system-ui, sans-serif`;
  ctx.fillText(info.subtitle, W / 2, titleY + 64 * unit);

  // soft glow, drawn per frame with an alpha that follows the music
  const glow = new OffscreenCanvas(W, H);
  const g = glow.getContext('2d');
  const rg = g.createRadialGradient(W / 2, H * 0.62, 0, W / 2, H * 0.62, Math.max(W, H) * 0.6);
  rg.addColorStop(0, 'rgba(242,155,56,0.16)');
  rg.addColorStop(1, 'rgba(242,155,56,0)');
  g.fillStyle = rg;
  g.fillRect(0, 0, W, H);
  return { background: canvas, glow };
}

function drawFrame(ctx, W, H, t, duration, levels, wave, statics) {
  const vertical = H > W;
  const unit = Math.min(W, H) / 1080;
  const pad = 80 * unit;
  ctx.drawImage(statics.background, 0, 0);
  ctx.globalAlpha = Math.min(1, 0.35 + levels.energy * 0.9);
  ctx.drawImage(statics.glow, 0, 0);
  ctx.globalAlpha = 1;

  // spectrum bars, mirrored
  const barsW = vertical ? W - pad * 2 : W * 0.72;
  const gap = 6 * unit;
  const bw = (barsW - gap * (BANDS - 1)) / BANDS;
  const x0 = (W - barsW) / 2;
  const base = vertical ? H * 0.6 : H * 0.68;
  const maxH = (vertical ? H * 0.17 : H * 0.24);
  const grad = ctx.createLinearGradient(0, base - maxH, 0, base);
  grad.addColorStop(0, '#ffcf8a');
  grad.addColorStop(1, '#f29b38');
  for (let b = 0; b < BANDS; b++) {
    const h = Math.max(4 * unit, levels.bands[b] * maxH);
    const x = x0 + b * (bw + gap);
    ctx.fillStyle = grad;
    roundRect(ctx, x, base - h, bw, h, Math.min(bw / 2, 6 * unit));
    ctx.fill();
    ctx.fillStyle = 'rgba(242,155,56,0.16)';
    roundRect(ctx, x, base + 8 * unit, bw, h * 0.45, Math.min(bw / 2, 6 * unit));
    ctx.fill();
  }

  // waveform of the current moment
  const waveY = vertical ? H * 0.78 : H * 0.85;
  const waveH = 50 * unit;
  ctx.beginPath();
  for (let i = 0; i < wave.length; i++) {
    const x = x0 + (i / (wave.length - 1)) * barsW;
    const y = waveY - wave[i] * waveH;
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  }
  ctx.strokeStyle = 'rgba(214,220,226,0.75)';
  ctx.lineWidth = 2.5 * unit;
  ctx.stroke();

  // progress
  const py = H - pad;
  ctx.fillStyle = '#2e343b';
  roundRect(ctx, x0, py - 6 * unit, barsW, 8 * unit, 4 * unit);
  ctx.fill();
  ctx.fillStyle = '#f29b38';
  roundRect(ctx, x0, py - 6 * unit, Math.max(8 * unit, barsW * Math.min(1, t / duration)), 8 * unit, 4 * unit);
  ctx.fill();
  ctx.font = `500 ${26 * unit}px "Cascadia Mono", Consolas, monospace`;
  ctx.fillStyle = '#9aa5b0';
  ctx.textAlign = 'left';
  ctx.fillText(fmtTime(t), x0, py - 24 * unit);
  ctx.textAlign = 'right';
  ctx.fillText(fmtTime(duration), x0 + barsW, py - 24 * unit);
  ctx.textAlign = 'left';
}

// audio: stereo AudioBuffer of the whole song. Returns the MP4 file as bytes.
// `draw(ctx, W, H, t, duration)` replaces the default visualizer (used by Graph Song videos).
export async function encodeMp4(audio, { layout = 'landscape', title, subtitle, onProgress = () => {}, isCancelled = () => false, draw = null }) {
  const mb = await import('../vendor/mediabunny.min.js');
  const { width: W, height: H } = VIDEO_LAYOUTS[layout];
  if (!(await mb.canEncodeVideo('avc', { width: W, height: H }))) throw new Error('This computer cannot encode H.264 video.');
  if (!(await mb.canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: audio.sampleRate }))) throw new Error('This computer cannot encode AAC audio.');

  const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new mb.BufferTarget() });
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const videoSource = new mb.CanvasSource(canvas, { codec: 'avc', bitrate: mb.QUALITY_HIGH, keyFrameInterval: 2 });
  const audioSource = new mb.AudioBufferSource({ codec: 'aac', bitrate: 192000 });
  output.addVideoTrack(videoSource, { frameRate: FPS });
  output.addAudioTrack(audioSource);
  await output.start();
  await audioSource.add(audio);

  // Mono mix for the visuals.
  const L = audio.getChannelData(0), R = audio.getChannelData(1);
  const mono = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) mono[i] = 0.5 * (L[i] + R[i]);

  const duration = audio.duration;
  const frames = Math.ceil(duration * FPS);
  const ranges = bandRanges(audio.sampleRate);
  const smooth = new Float32Array(BANDS);
  const wave = new Float32Array(240);
  const statics = drawStatic(W, H, { title, subtitle });
  for (let f = 0; f < frames; f++) {
    if (isCancelled()) {
      await output.cancel();
      throw new Error('Export cancelled.');
    }
    const t = f / FPS;
    if (draw) {
      draw(ctx, W, H, t, duration);
      await videoSource.add(t, 1 / FPS);
      if (f % 10 === 0) { onProgress(f / frames); await new Promise((r) => setTimeout(r, 0)); }
      continue;
    }
    const center = Math.floor(t * audio.sampleRate);
    const mag = magnitudeSpectrum(mono, Math.max(0, center - FFT_SIZE / 2), FFT_SIZE, FFT_SIZE);
    let energy = 0;
    for (let b = 0; b < BANDS; b++) {
      const [k0, k1] = ranges[b];
      let m = 0;
      for (let k = k0; k < k1 && k < mag.length; k++) m = Math.max(m, mag[k]);
      const db = 20 * Math.log10((m / (FFT_SIZE / 4)) + 1e-9); // ~0 dB for a full-scale sine
      const level = Math.min(1, Math.max(0, (db + 60) / 60));
      smooth[b] = level > smooth[b] ? level : smooth[b] * 0.82 + level * 0.18; // fast rise, slow fall
      energy += smooth[b];
    }
    const span = Math.floor(audio.sampleRate * 0.04);
    for (let i = 0; i < wave.length; i++) wave[i] = mono[center + Math.floor((i / wave.length) * span)] || 0;
    drawFrame(ctx, W, H, t, duration, { bands: smooth, energy: energy / BANDS }, wave, statics);
    await videoSource.add(t, 1 / FPS);
    if (f % 10 === 0) {
      onProgress(f / frames);
      await new Promise((r) => setTimeout(r, 0)); // keep the window responsive
    }
  }
  onProgress(1);
  await output.finalize();
  return new Uint8Array(output.target.buffer);
}
