// Generative AI: text prompt -> formula(s) and full songs, using a free LLM API the user configures.
// Every formula the model returns is checked by the real parser; invalid ones are sent back once for repair.
import { FUNCTIONS, check } from './formula.js';
import { LIBRARY } from './synth.js';
import { normalizeProject, STEPS_PER_BAR } from './project.js';
import { postJson } from './io.js';
import { uid } from './util.js';

const SETTINGS_KEY = 'quest.ai.v1';

export const PROVIDERS = {
  gemini: { label: 'Google Gemini', model: 'gemini-3.5-flash-lite', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  openai: { label: 'OpenAI-compatible (Groq, OpenRouter, Ollama ...)', model: 'llama-3.3-70b-versatile', baseUrl: 'https://api.groq.com/openai/v1' },
};

// Gemini only works at Google's API address; anything else (e.g. the AI Studio web page) is replaced by it.
const GEMINI_API = /^https:\/\/generativelanguage\.googleapis\.com\/v1(beta)?\/?$/;
function cleanSettings(s) {
  const provider = PROVIDERS[s.provider] ? s.provider : 'gemini';
  const out = {
    provider,
    apiKey: String(s.apiKey || '').trim(),
    model: String(s.model || PROVIDERS[provider].model).trim(),
    baseUrl: String(s.baseUrl || PROVIDERS[provider].baseUrl).trim(),
    addressFixed: false,
  };
  if (provider === 'gemini' && !GEMINI_API.test(out.baseUrl)) {
    out.baseUrl = PROVIDERS.gemini.baseUrl;
    out.addressFixed = true;
  }
  return out;
}

export function loadSettings() {
  try {
    return cleanSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
  } catch {
    return cleanSettings({});
  }
}

// Returns a warning to show the user, or ''.
export function saveSettings(s) {
  const clean = cleanSettings(s);
  const { addressFixed, ...stored } = clean;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(stored));
  const warnings = [];
  if (addressFixed) warnings.push(`The API address was not Google's AI address, so it was set to ${PROVIDERS.gemini.baseUrl}.`);
  if (clean.provider === 'gemini' && clean.apiKey && !/^(AIza|AQ)[0-9A-Za-z_\-\.]{10,}$/.test(clean.apiKey)) {
    warnings.push('The key does not look like a Gemini API key (they typically start with "AIza" or "AQ"). Copy it again from aistudio.google.com/apikey.');
  }
  return warnings.join(' ');
}

export const isConfigured = (s = loadSettings()) => !!s.model && (!!s.apiKey || /localhost|127\.0\.0\.1/.test(s.baseUrl));

// Pulls the JSON object out of the model's text. Tolerates code fences and trailing commas.
function extractJson(text) {
  const cleaned = String(text).replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw Object.assign(new Error('The AI answer contained no JSON.'), { badJson: true });
  const body = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch {
    try {
      return JSON.parse(body.replace(/,\s*([}\]])/g, '$1'));
    } catch (err) {
      throw Object.assign(new Error(`The AI answer was not valid JSON (${err.message}).`), { badJson: true });
    }
  }
}

// Other Gemini models to try when the chosen one is busy (Google returns 503 "high demand") or unavailable.
const GEMINI_FALLBACKS = ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-3.5-flash'];
const RETRY_WAITS = [2000, 5000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isBusy = (err) => err.status === 503 || err.status === 500 || /overloaded|high demand|unavailable|try again later/i.test(err.message);
const isRateLimited = (err) => err.status === 429;
const isMissingModel = (err) => err.status === 404 || /not found|not supported|no longer available|is not available/i.test(err.message);

async function requestOnce(system, user, settings, model) {
  const base = settings.baseUrl.replace(/\/+$/, '');
  if (settings.provider === 'gemini') {
    const data = await postJson(
      `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`,
      { 'x-goog-api-key': settings.apiKey },
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.9, maxOutputTokens: 32768 },
      });
    if (data.error) throw Object.assign(new Error(data.error.message || 'Gemini returned an error.'), { status: data.error.code });
    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts?.filter((p) => !p.thought).map((p) => p.text || '').join('');
    if (candidate?.finishReason === 'MAX_TOKENS') throw Object.assign(new Error('The AI answer was too long and got cut off.'), { badJson: true, tooLong: true });
    if (!text) throw new Error(`Gemini returned no text (${candidate?.finishReason || 'unknown reason'}).`);
    return extractJson(text);
  }
  const data = await postJson(
    `${base}/chat/completions`,
    settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {},
    { model, temperature: 0.9, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
  if (data.error) throw new Error(data.error.message || 'The AI service returned an error.');
  const choice = data.choices?.[0];
  if (choice?.finish_reason === 'length') throw Object.assign(new Error('The AI answer was too long and got cut off.'), { badJson: true, tooLong: true });
  const text = choice?.message?.content;
  if (!text) throw new Error('The AI service returned no text.');
  return extractJson(text);
}

// Calls the model; when the service is busy it waits and retries, then tries other Gemini models.
export let lastModelUsed = '';
async function callModel(system, user, onStatus = () => {}, settings = loadSettings()) {
  if (!isConfigured(settings)) throw new Error('AI is not set up. Open AI Settings and add a free API key.');
  const models = settings.provider === 'gemini'
    ? [settings.model, ...GEMINI_FALLBACKS.filter((m) => m !== settings.model)]
    : [settings.model];
  let lastError;
  for (const model of models) {
    for (let attempt = 0; attempt <= RETRY_WAITS.length; attempt++) {
      try {
        let result;
        try {
          result = await requestOnce(system, user, settings, model);
        } catch (err) {
          if (!err.badJson) throw err;
          onStatus(err.tooLong ? 'The answer was too long, asking for a more compact version ...' : 'The answer was broken, asking again ...');
          result = await requestOnce(system, `${user}

IMPORTANT: your previous answer was rejected (${err.message}) ` +
            'Reply again with ONE complete, valid JSON object and nothing else. Keep it compact: reuse library instruments by name, ' +
            'at most 5 patterns, and no comments.', settings, model);
        }
        lastModelUsed = model;
        return result;
      } catch (err) {
        lastError = err;
        if (err.badJson) throw new Error(`${err.message} The AI could not produce a complete answer twice. Try again, or ask for a shorter song.`);
        if (isMissingModel(err)) break; // this model is not available for the key: try the next one
        if (!isBusy(err) && !isRateLimited(err)) throw err; // wrong key, bad request ...: retrying will not help
        if (attempt < RETRY_WAITS.length) {
          onStatus(`${model} is busy at Google, retrying in ${RETRY_WAITS[attempt] / 1000} s ...`);
          await sleep(RETRY_WAITS[attempt]);
        }
      }
    }
    if (models.length > 1) onStatus(`${model} is unavailable, trying another Gemini model ...`);
  }
  throw new Error(`All Gemini models are busy or over the free limit right now (${lastError?.message || 'no answer'}). Wait a few minutes and try again.`);
}

const LANGUAGE = `FORMULA LANGUAGE (the only thing Quest Studio understands):
- A sound is ONE expression y = F(t, f, v). It is evaluated 44,100 times per second.
- t = seconds since the note started. f = note frequency in Hz (set by the piano roll). v = velocity 0..1.
- Constants: pi, tau (= 2*pi), e. Operators: + - * / % ^ and parentheses.
- Functions: ${Object.entries(FUNCTIONS).map(([n, [a, , d]]) => `${n}(${a === 1 ? 'x' : a === 2 ? 'a,b' : 'x,a,b'}) ${d}`).join('; ')}.
- sin/cos take radians: a tone of frequency F is sin(tau*F*t). saw/sqr/tri take cycles: saw(F*t).
- For a pitch that changes, the phase must be the integral of the frequency, e.g. a kick falling from 165 to 45 Hz:
  sin(tau*(45*t + 4*(1 - exp(-30*t)))).
- Multiply by v. Keep the peak level between 0.4 and 0.9 (never above 1). Use exp(-k*t) for decay, (1 - exp(-k*t)) for attack.
- "note" sounds use f so they follow the melody. "oneshot" sounds (drums, FX) ignore f and play for a fixed length.
- No other names, no variables, no semicolons, no if/else (use step()), max 400 characters.`;

const EXAMPLES = LIBRARY.filter((i) => i.formula.length <= 400).map((i) => `${i.name} (${i.mode}${i.mode === 'oneshot' ? `, length ${i.length}s` : `, release ${i.release}s`}): ${i.formula}`).join('\n');

export async function generateSound(description, onStatus = () => {}) {
  const system = `You are a sound designer for Quest Studio, a music studio where every sound is a math formula.
${LANGUAGE}

Working examples:
${EXAMPLES}

Answer with JSON only:
{"name": "short name", "mode": "note" or "oneshot", "length": seconds for oneshot (0.05-6), "release": seconds for note (0-2), "formula": "...", "explanation": "one sentence, plain words"}`;
  let result = await callModel(system, `Design this sound: ${description}`, onStatus);
  let err = check(String(result.formula || ''));
  if (err) {
    result = await callModel(system, `Your formula "${result.formula}" is invalid: ${err.message}. Fix it and answer with the same JSON format. Original request: ${description}`, onStatus);
    err = check(String(result.formula || ''));
    if (err) throw new Error(`The AI formula is still invalid: ${err.message}`);
  }
  return {
    name: String(result.name || 'AI Sound').slice(0, 40),
    mode: result.mode === 'oneshot' ? 'oneshot' : 'note',
    length: Math.min(6, Math.max(0.05, +result.length || 1)),
    release: Math.min(2, Math.max(0, +result.release || 0.1)),
    formula: String(result.formula),
    explanation: String(result.explanation || ''),
  };
}

const INSTRUMENT_LIST = LIBRARY.map((i) => `- ${i.name} (${i.group}, ${i.mode === 'oneshot' ? 'drum/FX hit' : 'plays notes'}): ${i.note}`).join('\n');

const SONG_FORMAT = `Answer with JSON only, in this exact shape:
{
  "name": "song title",
  "bpm": 50-200,
  "key": "e.g. D minor",
  "channels": [
    {"name": "unique name", "instrument": "<exact library instrument name>", "volume": 0-1},
    {"name": "unique name", "mode": "note" or "oneshot", "length": 0.05-6, "release": 0-2, "volume": 0-1, "formula": "..."}
  ],
  "patterns": [{
    "name": "Intro / Theme / Climax ...",
    "bars": 1-8,
    "steps": {"<channel name>": [step numbers]},
    "notes": {"<channel name>": [[step, length_in_steps, midi_key, velocity_0_to_1], ...]}
  }],
  "arrangement": [{"pattern": pattern_index_from_0, "track": 0-15, "bar": start_bar_from_0}]
}
Channels: prefer library instruments by name ("instrument"); write a "formula" only for a sound the library does not have.
Timing: ${STEPS_PER_BAR} steps per bar (16th notes), so a pattern of N bars has steps 0..N*16-1. Beat 1 = step 0, beat 2 = step 4.
Drums and FX use "steps" (oneshot). Melodic channels use "notes" with MIDI keys (60 = middle C, 57 = A3) that fit the key.
Velocity shapes emotion: soft (0.3-0.5) for intimate parts, rising velocities for build-ups, strong (0.8-1) for climaxes.
Give each instrument a real role: melody, counter-melody, chords (several notes on one step), bass line, arpeggios, rhythm.
Write 3-6 patterns and an arrangement of 24-48 bars that tells a story (intro, themes, build-up, climax, ending).
Put patterns on one track one after another; use other tracks only when patterns overlap in time.`;

// Library lookup that ignores case and spacing ("choir aah" = "Choir Aah").
const findInstrument = (name) => LIBRARY.find((i) => i.name.toLowerCase().replace(/\s+/g, '') === String(name || '').toLowerCase().replace(/\s+/g, ''));

// Converts the AI's name-based song JSON into a validated project.
function songToProject(song) {
  const nameToId = new Map();
  const channels = (Array.isArray(song.channels) ? song.channels : []).slice(0, 16).map((c) => {
    const id = uid('ch');
    nameToId.set(String(c.name), id);
    const lib = findInstrument(c.instrument);
    const sound = lib && !c.formula
      ? { formula: lib.formula, mode: lib.mode, length: lib.length, release: lib.release, color: lib.color }
      : { formula: c.formula, mode: c.mode, length: c.length, release: c.release, color: undefined };
    return { name: c.name, volume: c.volume, ...sound, id };
  });
  const patterns = (Array.isArray(song.patterns) ? song.patterns : []).slice(0, 12).map((p) => {
    const steps = {}, notes = {};
    for (const [name, list] of Object.entries(p.steps || {})) if (nameToId.has(name)) steps[nameToId.get(name)] = list;
    for (const [name, list] of Object.entries(p.notes || {})) {
      if (!nameToId.has(name) || !Array.isArray(list)) continue;
      notes[nameToId.get(name)] = list.filter(Array.isArray).map(([step, len, key, vel]) => ({ step, len, key, vel: vel ?? 0.8 }));
    }
    return { id: uid('pt'), name: p.name, bars: p.bars, steps, notes };
  });
  const playlist = (Array.isArray(song.arrangement) ? song.arrangement : [])
    .filter((a) => patterns[a?.pattern])
    .map((a) => ({ id: uid('cl'), pattern: patterns[a.pattern].id, track: a.track, bar: a.bar }));
  const palette = ['#e8743b', '#e0b84a', '#9fcf6a', '#64b5f6', '#7bd389', '#f06292', '#ffb74d', '#ba68c8', '#6fd6c6'];
  channels.forEach((c, i) => { c.color = c.color || palette[i % palette.length]; });
  return normalizeProject({ name: song.name, bpm: song.bpm, channels, patterns, playlist, master: { reverb: 0.25 } });
}

export async function generateSong(prompt, onStatus = () => {}) {
  const system = `You are a film and music composer inside Quest Studio, where every instrument is a math formula.
Library instruments (use them by exact name):
${INSTRUMENT_LIST}

${LANGUAGE}

${SONG_FORMAT}`;
  onStatus('Asking the AI to compose ...');
  const song = await callModel(system, `Compose: ${prompt}`, onStatus);
  const custom = (song.channels || []).filter((c) => !(findInstrument(c.instrument) && !c.formula));
  const invalid = custom.map((c) => [c.name, check(String(c?.formula ?? ''))]).filter(([, e]) => e);
  if (invalid.length) {
    onStatus(`Fixing ${invalid.length} invalid formula(s) ...`);
    const fix = await callModel(system,
      `These formulas from your song are invalid:\n${invalid.map(([n, e]) => `${n}: "${song.channels.find((c) => c.name === n).formula}" -> ${e.message}`).join('\n')}\n` +
      'Answer with JSON only: {"fixes": {"<channel name>": "<corrected formula or exact library instrument name>"}}', onStatus);
    for (const c of song.channels) {
      const f = fix?.fixes?.[c.name];
      if (!f) continue;
      if (findInstrument(f)) { c.instrument = f; delete c.formula; } else c.formula = String(f);
    }
  }
  onStatus('Checking the result ...');
  const { project, problems } = songToProject(song);
  if (!project.channels.length) throw new Error('The AI song had no valid instruments.');
  return { project, problems, key: song.key ? String(song.key) : '' };
}

// Graph Song: the AI writes formula graphs y = g(x) that are heard as pitch.
const GRAPH_GUIDE = `GRAPH SONG RULES (Quest Studio "graphing calculator" mode):
- Each layer is ONE formula y = g(x). x = time in beats (x = 4 is the start of bar 2). The graph is heard as pitch:
  frequency = base note * 2^y, so y = 0 is the base note, y = 1 one octave up, y = 1/12 one semitone up.
- Where y is undefined the layer is silent: use if(c, a, nan) to play a only while c > 0.
- Useful tools: frac(x) (position inside the beat), floor(x), mod(a,b), round, exp, if(c,a,b).
  Kick (pitch falls fast each beat): if(0.45 - frac(x), 2.6*exp(-14*frac(x)) - 1.4, nan) with base A2.
  Melody of 8th notes on a scale: if(0.6 - frac(2*x), round(12*mod(3*floor(2*x), 7)/7)/12, nan).
  Chord root per bar: if(0.5 - mod(floor(x/4),4), 0, if(1.5 - mod(floor(x/4),4), -4, -2)) / 12.
- Functions available: ${Object.keys(FUNCTIONS).join(', ')}. Constants: pi, tau, e, nan. No other names, max 400 characters each.
Answer with JSON only: {"bars": 1-16, "bpm": 60-180, "layers": [{"name": "...", "formula": "...", "key": base MIDI note 24-96, "wave": "sine" | "warm" | "square", "volume": 0-1}]}
Write 2-5 layers (for example kick, bass, melody, high counter-melody) that fit together in one key.`;

export async function generateGraphSong(description, onStatus = () => {}) {
  const system = `You compose "graphing calculator songs": music written as mathematical graphs.\n${GRAPH_GUIDE}`;
  onStatus('Asking the AI to write the graphs ...');
  let song = await callModel(system, `Write a graph song: ${description}`, onStatus);
  const bad = (song.layers || []).map((l) => [l.name, check(String(l?.formula ?? ''))]).filter(([, e]) => e);
  if (bad.length) {
    onStatus(`Fixing ${bad.length} invalid formula(s) ...`);
    song = await callModel(system, `Your graph song had invalid formulas:\n${bad.map(([n, e]) => `${n}: ${e.message}`).join('\n')}\n` +
      `Original request: ${description}\nAnswer again with the full corrected JSON.`, onStatus);
  }
  const layers = (Array.isArray(song.layers) ? song.layers : []).slice(0, 8)
    .filter((l) => !check(String(l?.formula ?? '')))
    .map((l) => ({
      name: String(l.name || 'Layer').slice(0, 30),
      formula: String(l.formula),
      key: Math.round(Math.min(96, Math.max(24, +l.key || 57))),
      wave: ['sine', 'warm', 'square'].includes(l.wave) ? l.wave : 'sine',
      volume: Math.min(1, Math.max(0, Number.isFinite(+l.volume) ? +l.volume : 0.4)),
    }));
  if (!layers.length) throw new Error('The AI did not return any valid graph formulas. Try again.');
  return { bars: Math.round(Math.min(16, Math.max(1, +song.bars || 4))), bpm: Math.round(Math.min(180, Math.max(60, +song.bpm || 120))), layers };
}
