// Turns formulas into sample data. Every sound in Quest Studio, including the built-in
// instruments, goes through renderFormula(): there are no hidden sample files or preset synths.
import { compileForNote } from './formula.js';

export const FADE_SECONDS = 0.005;

// The one fixed rule (Hermann 2008, condition C2), shown in the app and the report.
export const RENDER_RULE =
  'y[n] = F(t = n / sampleRate, f = note frequency, v = velocity) for n = 0 ... N-1. ' +
  'One-shot sounds play for the channel length; note sounds play for the note length plus the release time, ' +
  'with a linear fade over the release. The last 5 ms are faded to zero to prevent clicks.';

// Raw formula output with no fades. Invalid results (NaN, Infinity) become 0 and are counted.
export function renderFormula(source, { f = 440, v = 1, duration = 1, sampleRate = 44100 } = {}) {
  const fn = compileForNote(source, f, v);
  const length = Math.max(1, Math.round(duration * sampleRate));
  const data = new Float32Array(length);
  const env = { t: 0, f, v };
  let invalid = 0;
  for (let n = 0; n < length; n++) {
    env.t = n / sampleRate;
    const y = fn(env);
    if (Number.isFinite(y)) data[n] = y;
    else invalid++;
  }
  return { data, invalid, sampleRate };
}

// Applies the documented release fade + anti-click fade (in place).
export function applyFades(data, sampleRate, releaseSeconds = 0) {
  const n = data.length;
  const release = Math.min(n, Math.round(releaseSeconds * sampleRate));
  for (let i = 0; i < release; i++) data[n - release + i] *= 1 - i / release;
  const fade = Math.min(n, Math.round(FADE_SECONDS * sampleRate));
  for (let i = 0; i < fade; i++) data[n - fade + i] *= 1 - (i + 1) / fade;
  return data;
}

export const keyToFreq = (key) => 440 * Math.pow(2, (key - 69) / 12);

export function soundDuration(channel, noteSeconds) {
  return channel.mode === 'oneshot' ? channel.length : noteSeconds + channel.release;
}

// Everything needed to render one note, plus a cache id built from everything that affects the samples.
export function soundJob(channel, key, noteSeconds, velocity, sampleRate) {
  const duration = soundDuration(channel, noteSeconds);
  const f = keyToFreq(key);
  return {
    id: `${channel.formula}|${sampleRate}|${f.toFixed(5)}|${velocity}|${duration.toFixed(5)}|${channel.mode}|${channel.release}`,
    formula: channel.formula, f, v: velocity, duration, sampleRate,
    release: channel.mode === 'oneshot' ? 0 : channel.release,
  };
}

// Pure sample computation (also runs inside the render workers).
export function renderJob(job) {
  const { data } = renderFormula(job.formula, { f: job.f, v: job.v, duration: job.duration, sampleRate: job.sampleRate });
  return applyFades(data, job.sampleRate, job.release);
}

// Cache of ready-to-play AudioBuffers.
const bufferCache = new Map();
const MAX_BUFFERS = 1500;

export const hasBuffer = (id) => bufferCache.has(id);

export function storeBuffer(ctx, id, data) {
  const buffer = ctx.createBuffer(1, data.length, ctx.sampleRate);
  buffer.copyToChannel(data, 0);
  if (bufferCache.size >= MAX_BUFFERS) bufferCache.delete(bufferCache.keys().next().value);
  bufferCache.set(id, buffer);
  return buffer;
}

export function getBuffer(ctx, channel, key, noteSeconds, velocity) {
  const job = soundJob(channel, key, noteSeconds, velocity, ctx.sampleRate);
  const buffer = bufferCache.get(job.id);
  if (buffer) {
    bufferCache.delete(job.id);
    bufferCache.set(job.id, buffer); // mark as recently used
    return buffer;
  }
  return storeBuffer(ctx, job.id, renderJob(job));
}

// Instrument library. Each one is only a formula plus how it is triggered.
// t = seconds since the note started, f = note frequency (Hz), v = velocity.
export const LIBRARY = [
  {
    group: 'Drums', name: 'Kick', mode: 'oneshot', length: 0.6, color: '#e8743b',
    note: 'Sine whose pitch falls from 165 Hz to 45 Hz (phase = integral of frequency).',
    formula: 'v * sin(tau*(45*t + 4*(1 - exp(-30*t)))) * exp(-6*t)',
  },
  {
    group: 'Drums', name: 'Punch Kick', mode: 'oneshot', length: 0.5, color: '#e8743b',
    note: 'Kick with tanh saturation for a harder attack.',
    formula: 'v * tanh(2.2*sin(tau*(50*t + 5*(1 - exp(-38*t))))) * exp(-8*t)',
  },
  {
    group: 'Drums', name: 'Snare', mode: 'oneshot', length: 0.35, color: '#e0b84a',
    note: 'Noise burst plus a 185 Hz body tone.',
    formula: 'v * (0.5*noise(t)*exp(-17*t) + 0.45*sin(tau*185*t)*exp(-24*t))',
  },
  {
    group: 'Drums', name: 'Clap', mode: 'oneshot', length: 0.4, color: '#e0b84a',
    note: 'Three quick noise bursts then a tail.',
    formula: 'v * 0.6*noise(t) * (exp(-90*t) + exp(-90*max(0, t-0.011))*step(t-0.011) + exp(-14*max(0, t-0.022))*step(t-0.022))',
  },
  {
    group: 'Drums', name: 'Closed Hat', mode: 'oneshot', length: 0.12, color: '#9fcf6a',
    note: 'Six detuned square waves (metallic) plus noise, short decay.',
    formula: 'v * (0.09*(sqr(317*t) + sqr(421*t) + sqr(543*t) + sqr(612*t) + sqr(812*t) + sqr(1019*t)) + 0.3*noise(t)) * exp(-55*t)',
  },
  {
    group: 'Drums', name: 'Open Hat', mode: 'oneshot', length: 0.6, color: '#9fcf6a',
    note: 'Same metal as the closed hat with a longer decay.',
    formula: 'v * (0.08*(sqr(317*t) + sqr(421*t) + sqr(543*t) + sqr(612*t) + sqr(812*t) + sqr(1019*t)) + 0.25*noise(t)) * exp(-8*t)',
  },
  {
    group: 'Drums', name: 'Rim', mode: 'oneshot', length: 0.1, color: '#9fcf6a',
    note: 'Two high sines with a very fast decay.',
    formula: 'v * 0.6*(sin(tau*1650*t) + 0.6*sin(tau*820*t)) * exp(-70*t)',
  },
  {
    group: 'Drums', name: 'Phonk Cowbell', mode: 'note', release: 0.08, color: '#d873c9',
    note: '808-style cowbell: two square waves at a 1 : 1.48 ratio.',
    formula: 'v * 0.2*(sqr(f*t) + sqr(1.48*f*t)) * exp(-5*t)',
  },
  {
    group: 'Bass', name: '808 Glide', mode: 'note', release: 0.12, color: '#64b5f6',
    note: 'Sine that starts 2.5x higher and glides to the note, saturated with tanh.',
    formula: 'v * 0.85*tanh(1.6*sin(tau*(f*t + 1.5*f*(1 - exp(-25*t))/25))) * exp(-1.2*t)',
  },
  {
    group: 'Bass', name: 'Saw Bass', mode: 'note', release: 0.05, color: '#64b5f6',
    note: 'Sawtooth plus a sub sine an octave down.',
    formula: 'v * (0.3*saw(f*t) + 0.45*sin(tau*0.5*f*t)) * exp(-3*t)',
  },
  {
    group: 'Keys', name: 'Piano', mode: 'note', release: 0.25, color: '#7bd389',
    note: 'Additive harmonics; higher harmonics fade faster, like a struck string.',
    formula: 'v * 0.42*(sin(tau*f*t) + 0.5*sin(2*tau*f*t)*exp(-2*t) + 0.25*sin(3*tau*f*t)*exp(-4*t) + 0.12*sin(4*tau*f*t)*exp(-6*t)) * exp(-2.2*t) * (1 - exp(-400*t))',
  },
  {
    group: 'Keys', name: 'FM Rhodes', mode: 'note', release: 0.3, color: '#7bd389',
    note: 'Two-operator FM (Chowning 1973): the modulation index decays for a bell-like attack.',
    formula: 'v * 0.5*sin(tau*f*t + 1.3*exp(-3*t)*sin(tau*f*t)) * exp(-1.6*t) * (1 - exp(-300*t))',
  },
  {
    group: 'Keys', name: 'Bell', mode: 'note', release: 0.5, color: '#7bd389',
    note: 'Inharmonic FM ratio 1 : 3.5 gives a metallic bell.',
    formula: 'v * 0.45*sin(tau*f*t + 2*exp(-2*t)*sin(3.5*tau*f*t)) * exp(-1.4*t)',
  },
  {
    group: 'Leads', name: 'Synth Pluck', mode: 'note', release: 0.08, color: '#f06292',
    note: 'Bright sawtooth with a fast decay.',
    formula: 'v * 0.35*(saw(f*t) + 0.5*saw(1.005*f*t)) * exp(-7*t)',
  },
  {
    group: 'Leads', name: 'Flute', mode: 'note', release: 0.15, color: '#f06292',
    note: 'Sine with 5 Hz vibrato (phase modulation), soft attack and breath noise.',
    formula: 'v * (1 - exp(-12*t)) * (0.42*sin(tau*f*t + 0.8*sin(tau*5*t)) + 0.08*sin(2*tau*f*t) + 0.03*noise(t))',
  },
  {
    group: 'Leads', name: 'Sitar', mode: 'note', release: 0.3, color: '#ffb74d',
    note: 'Bright plucked tone with a buzzing, slowly moving overtone (synthesized, not sampled).',
    formula: 'v * 0.4*tanh(2.4*sin(tau*f*t + (1.2 + 0.6*sin(tau*3*t))*exp(-1.5*t)*sin(2*tau*f*t))) * exp(-1.3*t) * (1 - exp(-600*t))',
  },
  {
    group: 'Indian', name: 'Gejje Bells', mode: 'oneshot', length: 0.5, color: '#ffd166',
    note: 'Ankle bells: four high inharmonic partials struck twice 35 ms apart, plus a little noise.',
    formula: 'v * (0.11*(sin(tau*3150*t) + sin(tau*4420*t) + sin(tau*5310*t) + sin(tau*6870*t))*(exp(-22*t) + 0.7*step(t-0.035)*exp(-22*max(0, t-0.035))) + 0.12*noise(t)*exp(-45*t))',
  },
  {
    group: 'Indian', name: 'Tanpura', mode: 'note', release: 1.5, color: '#c9a227',
    note: 'Drone string: harmonics through tanh for the buzzing jawari sound; the 2nd harmonic slowly shimmers.',
    formula: 'v * 0.3*tanh(1.6*(sin(tau*f*t) + 0.6*sin(2*tau*f*t + 0.4*sin(tau*0.7*t)) + 0.35*sin(3*tau*f*t))) * exp(-0.6*t) * (1 - exp(-60*t))',
  },
  {
    group: 'Indian', name: 'Dhol', mode: 'oneshot', length: 0.7, color: '#e8743b',
    note: 'Big folk drum: pitch falls from 128 Hz to 62 Hz, plus a stick slap (noise).',
    formula: 'v * (0.75*sin(tau*(62*t + 2.2*(1 - exp(-28*t))))*exp(-5*t) + 0.25*noise(t)*exp(-70*t))',
  },
  {
    group: 'Indian', name: 'Tabla Na', mode: 'oneshot', length: 0.4, color: '#e0b84a',
    note: 'Treble tabla stroke: 510 Hz with harmonic overtones that fade faster, plus a finger click.',
    formula: 'v * ((0.45*sin(tau*510*t) + 0.25*sin(tau*1020*t)*exp(-6*t) + 0.15*sin(tau*1530*t)*exp(-10*t))*exp(-8*t) + 0.15*noise(t)*exp(-90*t))',
  },
  {
    group: 'Indian', name: 'Tabla Bayan', mode: 'oneshot', length: 0.8, color: '#e0b84a',
    note: 'Bass tabla with the palm sliding: pitch rises from 80 Hz (gamak).',
    formula: 'v * 0.8*sin(tau*(80*t + 12*t^2))*exp(-3.5*t)*(1 - exp(-300*t))',
  },
  {
    group: 'Indian', name: 'Temple Bell', mode: 'oneshot', length: 4, color: '#ffd166',
    note: 'Large bell: inharmonic partials (1 : 2.5 : 3.9 : 5.9) with long, different decays.',
    formula: 'v * 0.4*(sin(tau*440*t) + 0.6*sin(tau*1102*t)*exp(-1.5*t) + 0.4*sin(tau*1726*t)*exp(-2*t) + 0.25*sin(tau*2611*t)*exp(-3*t)) * exp(-0.9*t)',
  },
  {
    group: 'Indian', name: 'Shehnai', mode: 'note', release: 0.2, color: '#f06292',
    note: 'Double-reed lead: tanh gives the nasal tone; vibrato (5.5 Hz) grows as the note is held.',
    formula: 'v * (1 - exp(-15*t)) * 0.4*tanh(3*sin(tau*f*t + 0.5*(1 - exp(-2*t))*sin(tau*5.5*t)))',
  },
  {
    group: 'Orchestral', name: 'Cello', mode: 'note', release: 0.5, color: '#a1887f',
    note: 'Bowed string: five harmonics with falling strength, slow bow attack and vibrato that grows as the note is held.',
    formula: `v * (1 - exp(-5*t)) * 0.28*(${[1, 0.6, 0.4, 0.25, 0.15].map((a, i) => `${a}*sin(${i + 1}*(tau*f*t + 0.25*(1 - exp(-1.5*t))*sin(tau*5*t)))`).join(' + ')})`,
  },
  {
    group: 'Orchestral', name: 'French Horn', mode: 'note', release: 0.4, color: '#e0a64a',
    note: 'Warm brass: tanh drive that rises during the note, so the tone opens up like a player blowing harder.',
    formula: 'v * 0.45*tanh((1.2 + 1.8*(1 - exp(-4*t)))*sin(tau*f*t + 0.15*(1 - exp(-2*t))*sin(tau*4.5*t))) * (1 - exp(-10*t))',
  },
  {
    group: 'Orchestral', name: 'Choir Aah', mode: 'note', release: 0.9, color: '#b39ddb',
    note: 'Formant synthesis of an "aah" vowel: each harmonic is weighted by the vowel\'s resonances at 700, 1220 and 2600 Hz.',
    formula: `v * 0.18*(1 - exp(-3*t))*(${[1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
      `(exp(-((${n}*f-700)/180)^2) + 0.5*exp(-((${n}*f-1220)/220)^2) + 0.25*exp(-((${n}*f-2600)/350)^2) + 0.12)*sin(${n}*(tau*f*t + 0.3*(1 - exp(-1.2*t))*sin(tau*5.2*t)))`).join(' + ')})`,
  },
  {
    group: 'Orchestral', name: 'Timpani', mode: 'note', release: 0.6, color: '#e8743b',
    note: 'Tuned kettle drum: starts 6% sharp and settles to the note, with partials at 1.5x and 2x and a mallet click.',
    formula: 'v * ((0.5*sin(tau*(f*t + 0.06*f*(1 - exp(-8*t))/8)) + 0.2*sin(tau*1.5*f*t)*exp(-3*t) + 0.12*sin(tau*2*f*t)*exp(-4*t))*exp(-1.6*t) + 0.12*noise(t)*exp(-50*t))',
  },
  {
    group: 'Orchestral', name: 'Taiko', mode: 'oneshot', length: 1.2, color: '#e8743b',
    note: 'Huge war drum: pitch falls from 80 Hz to 48 Hz with a long body and a hard hit.',
    formula: 'v * (0.75*sin(tau*(48*t + 1.6*(1 - exp(-20*t))))*exp(-3.5*t) + 0.25*noise(t)*exp(-25*t))',
  },
  {
    group: 'Orchestral', name: 'Harp', mode: 'note', release: 0.6, color: '#7bd389',
    note: 'Plucked string: bright attack whose upper harmonics fade first.',
    formula: 'v * 0.45*(sin(tau*f*t) + 0.45*sin(2*tau*f*t)*exp(-3*t) + 0.2*sin(3*tau*f*t)*exp(-6*t)) * exp(-1.8*t) * (1 - exp(-800*t))',
  },
  {
    group: 'Orchestral', name: 'Duduk', mode: 'note', release: 0.3, color: '#f06292',
    note: 'Mournful double reed: soft tanh tone, slow vibrato and a little breath.',
    formula: 'v * (1 - exp(-6*t)) * (0.4*tanh(1.6*sin(tau*f*t + 0.35*(1 - exp(-1.5*t))*sin(tau*4.5*t))) + 0.03*noise(t))',
  },
  {
    group: 'Orchestral', name: 'Cymbal Swell', mode: 'oneshot', length: 3, color: '#90a4ae',
    note: 'Cymbal rolled softly to loud over 3 seconds: noise plus two metallic tones, growing as t squared.',
    formula: 'v * (0.22*noise(t) + 0.04*(sqr(5100*t) + sqr(7300*t))) * (t/3)^2',
  },
  {
    group: 'Pads', name: 'Strings', mode: 'note', release: 0.6, color: '#ba68c8',
    note: 'Three detuned saws with a slow attack (ensemble effect).',
    formula: 'v * 0.16*(saw(0.997*f*t) + saw(1.003*f*t) + 0.6*saw(2.001*f*t)) * (1 - exp(-4*t))',
  },
  {
    group: 'Pads', name: 'Warm Pad', mode: 'note', release: 0.8, color: '#ba68c8',
    note: 'Soft sines with slow beating between detuned voices.',
    formula: 'v * 0.3*(sin(tau*f*t) + sin(tau*1.004*f*t) + 0.4*sin(tau*2*f*t)) * (1 - exp(-3*t))',
  },
  {
    group: 'FX', name: 'Vinyl Crackle', mode: 'oneshot', length: 4, color: '#90a4ae',
    note: 'Quiet hiss plus rare random clicks.',
    formula: '0.025*noise(t) + 0.4*step(noise(t + 7) - 0.9993)*noise(t + 3)',
  },
  {
    group: 'FX', name: 'Riser', mode: 'oneshot', length: 2, color: '#90a4ae',
    note: 'Noise that gets louder plus a rising tone (pitch 200 to 800 Hz).',
    formula: '(0.2*noise(t) + 0.3*sin(tau*(200*t + 150*t^2))) * (t/2)^2',
  },
];

export function libraryItem(name) {
  return LIBRARY.find((i) => i.name === name);
}
