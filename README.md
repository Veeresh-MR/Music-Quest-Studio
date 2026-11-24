# 🎵 Quest Studio

> **Verifiable Formula-to-Audio Generation in an LLM-Assisted Music Studio**  
> *A deterministic, proof-carrying digital audio workstation where every sound is purely a mathematical equation.*

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tauri](https://img.shields.io/badge/Tauri-v2-blue?logo=tauri)](https://tauri.app/)
[![Rust](https://img.shields.io/badge/Rust-Backend-orange?logo=rust)](https://www.rust-lang.org/)
[![JavaScript](https://img.shields.io/badge/Frontend-Vanilla_JS-yellow?logo=javascript)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![Web Audio API](https://img.shields.io/badge/Audio-Web_Audio_API-brightgreen)](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)
[![Gemini](https://img.shields.io/badge/Gen_AI-Google_Gemini-4285F4?logo=google)](https://ai.google.dev/)

---

## 📌 Overview

**Quest Studio** is a desktop Digital Audio Workstation (DAW) and sonification research platform founded on a novel paradigm:
1. **Zero Pre-Recorded Audio Samples:** Every instrument—grand pianos, sub-bass 808s, acoustic flutes, violins, Indian sitars, tablas, and synthetic phonk cowbells—is generated **sample-by-sample** directly from explicit, closed-form mathematical equations.
2. **Proof-Carrying Audio Verification:** Every formula is tested against **Thomas Hermann's 4 Foundational Sonification Criteria (ICAD 2008)** before it enters your arrangement, validating frequency accuracy with Fast Fourier Transforms (FFT) and double-precision re-computation.
3. **Graph Song Mode:** Graphing-calculator music where continuous mathematical functions $y = g(x)$ plotted across musical beats are heard directly as melodic pitch.
4. **Autonomous AI Composer:** An integrated Google Gemini LLM pipeline that turns natural language briefs into validated 32-bar symphonic arrangements using few-shot prompting and an autonomous AST Self-Refine repair loop.

---

## 🏛️ System Architecture

```
                  ┌────────────────────────────────────────┐
                  │          Natural Language Prompt       │
                  └───────────────────┬────────────────────┘
                                      │
                                      ▼
                  ┌────────────────────────────────────────┐
                  │    Google Gemini Generative AI (LLM)   │
                  └───────────────────┬────────────────────┘
                                      │ (Structured JSON)
                                      ▼
                  ┌────────────────────────────────────────┐
                  │    Safe Math AST Parser (No eval)      │◄───┐
                  └───────────────────┬────────────────────┘    │ Self-Refine
                                      │                         │ Error Feedback
                                      ▼                         │
                  ┌────────────────────────────────────────┐    │
                  │   Deterministic DSP Engine (44.1 kHz)  ├────┘
                  └───────────────────┬────────────────────┘
                                      │
            ┌─────────────────────────┴─────────────────────────┐
            ▼                                                   ▼
┌──────────────────────────────┐            ┌────────────────────────────────────────┐
│     Interactive DAW Suite    │            │     Automated Verification Engine      │
│  • Channel Rack (F6)         │            │  • C1: Independent Re-computation (2⁻²⁴)│
│  • Piano Roll (F7)           │            │  • C1: Symbolic-vs-FFT Spectral Test   │
│  • 32-Bar Playlist (F5)      │            │  • C1: STFT Instantaneous Pitch Track  │
│  • Master Mixer & FX (F9)    │            │  • C3: Bit-Exact Hash Reproducibility  │
│  • Lossless WAV / MP4 Export │            │  • C4: Cross-Formula Generality        │
└──────────────────────────────┘            └────────────────────────────────────────┘
```

---

## ✨ Key Features

### 1. 🧮 100% Mathematical Sound Synthesis
Every sound evaluates the function:
$$y(t) = F(t, f, v)$$
* $t$ = elapsed time in seconds
* $f$ = note frequency in Hertz ($440 \cdot 2^{(\text{MIDI} - 69)/12}$)
* $v$ = note velocity / amplitude ($0 \dots 1$)
* Evaluated **44,100 times per second** ($44.1\text{ kHz}$) with zero recorded samples, wavetables, or audio assets.

### 2. 🔬 Automated Hermann Sonification Verification (C1–C4)
Translates Hermann's ICAD 2008 sonification taxonomy into mathematical proofs:
* **C1 (Objective Reflection):**
  * *Arbitrary-Precision Sample Check:* Verifies compiled closures against a 64-bit double-precision interpreter down to machine epsilon ($|y_{\text{render}} - y_{\text{ref}}| \le 2^{-24} |y_{\text{ref}}|$).
  * *Two-Way Symbolic vs. FFT Test:* Predicts harmonic overtones, FM Bessel sidebands ($f_c \pm k f_m$), and aliasing foldover frequencies, comparing them to an 8,192-point Hann-windowed FFT with parabolic peak interpolation.
  * *Continuous Pitch Tracking:* Adaptive STFT tracking with instantaneous frequency estimation for continuous nonlinear portamento sweeps and kick drops.
* **C2 (Systematic Transformation):** Fixed discrete rendering rule $y[n] = F(n/f_s, f, v)$ published and guaranteed across the platform.
* **C3 (Reproducibility):** Dual-pass cryptographic hashing ensuring bit-exact identical reproduction.
* **C4 (Generality):** Uniform verification pipeline applied equally across factory presets, user-typed formulas, and LLM-generated arrangements.

### 3. 📈 Graph Song Calculator Mode
Compose music as mathematical curves $y = g(x)$ where $x$ represents beats:
$$x[n] = \frac{n \cdot B}{60 \cdot f_s}, \quad f[n] = f_0 \cdot 2^{g(x[n])}$$
* $y = 0 \implies \text{Base Note } (f_0 = 220\text{ Hz})$
* $\Delta y = 1 \implies \text{Octave Jump } (2\times f)$
* $\Delta y = 1/12 \implies \text{Semitone Interval}$
* Piecewise evaluation with automatic $3\text{ ms}$ silence gating on undefined regions.

### 4. 🤖 LLM-Assisted Composition with Self-Refine
* Integrates Google Gemini (`gemini-3.5-flash`) via structured JSON schema and few-shot domain prompting.
* Employs an automated **Self-Refine feedback loop** (Madaan et al., 2023): if an LLM emits an invalid formula, compiler diagnostics are returned to the model for instantaneous autonomous repair before entering the audio pipeline.

### 5. 🎛️ Full Digital Audio Workstation (DAW)
* **Channel Rack (F6):** Multi-instrument formula management with live oscilloscope visualization.
* **Piano Roll (F7):** Polyphonic MIDI note editing with velocity sensitivity and multi-bar loop selection.
* **Playlist Arrangement (F5):** 32-bar timeline arranger with in-clip Bézier automation envelopes and volume fading.
* **Master Mixer & DSP Rack (F9):** Channel strips, stereo panning, algorithmic reverb (convolver), and dynamic peak limiter.
* **Export Engine:** Lossless 16-bit WAV rendering and direct MP4 video generation (audio + animated spectrum / graphing visualizer).

---

## 📊 Experimental Results & Benchmarks

All metrics benchmarked on AMD Ryzen 5 5600H (6 cores, 12 threads @ 3.30 GHz), Node.js v22.14.0, $f_s = 44,100\text{ Hz}$:

### 1. Verification of 35 Built-in Instruments by Group
| Group | Instruments ($N$) | Samples Evaluated | Numeric Mismatches | Tones (Max Error) | Peaks Explained | Glides Tracked | Pass Rate |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Drums** | 8 | 183,897 | 0 | 17 (0.49 Hz) | 10 / 10 | 2 | **8 / 8 (100%)** |
| **Bass** | 2 | 132,300 | 0 | 2 (0.00 Hz) | 8 / 8 | 1 | **2 / 2 (100%)** |
| **Keys** | 3 | 198,450 | 0 | 4 (0.00 Hz) | 10 / 10 | -- | **3 / 3 (100%)** |
| **Leads** | 3 | 198,450 | 0 | 2 (0.00 Hz) | 13 / 13 | -- | **3 / 3 (100%)** |
| **Indian Classical** | 7 | 414,540 | 0 | 15 (0.28 Hz) | 19 / 19 | 2 | **7 / 7 (100%)** |
| **Orchestral** | 8 | 582,120 | 0 | 22 (0.20 Hz) | 25 / 25 | 1 | **8 / 8 (100%)** |
| **Pads** | 2 | 132,300 | 0 | 2 (0.30 Hz) | 10 / 10 | -- | **2 / 2 (100%)** |
| **Effects (FX)** | 2 | 264,600 | 0 | -- | -- | 1 | **2 / 2 (100%)** |
| **TOTAL** | **35** | **2,106,657** | **0** | **64 (0.49 Hz)** | **95 / 95 (100%)** | **7** | **35 / 35 (100%)** |

### 2. Reference Pure Tone Precision ($27.5\text{ Hz} - 18,000\text{ Hz}$)
| Nominal Frequency (Hz) | Measured Frequency (Hz) | Absolute Error (Hz) | Status |
| :---: | :---: | :---: | :---: |
| 27.5000 ($A_0$) | 27.4973 | 0.0027 | **PASS** |
| 55.0000 ($A_1$) | 54.9959 | 0.0041 | **PASS** |
| 110.0000 ($A_2$) | 110.0012 | 0.0012 | **PASS** |
| 220.0000 ($A_3$) | 219.9987 | 0.0013 | **PASS** |
| 440.0000 ($A_4$) | 439.9974 | 0.0026 | **PASS** |
| 1,000.0000 | 1,000.0016 | 0.0016 | **PASS** |
| 4,000.0000 | 4,000.0041 | 0.0041 | **PASS** |
| 10,000.0000 | 9,999.9961 | 0.0039 | **PASS** |
| 18,000.0000 | 18,000.0034 | 0.0034 | **PASS** |

### 3. Adversarial Negative Sensitivity Testing
| Injected Corrupted Audio | Expected Result | Verification Engine Output |
| :--- | :---: | :---: |
| 450 Hz tone checked as $\sin(\tau \cdot 440 \cdot t)$ | Reject | **REJECTED** |
| 441 Hz tone checked as $\sin(\tau \cdot 440 \cdot t)$ (1 Hz off) | Reject | **REJECTED** |
| 1 single sample altered by $+0.01$ (out of 44,100) | Reject | **REJECTED** |
| FM carrier ratio $1:3$ checked as $1:3.5$ | Reject | **REJECTED** |
| Graph curve shifted by 1 semitone ($\Delta y = 1/12$) | Reject | **REJECTED** |
| Uncorrupted authentic audio (Clean Control) | Accept | **ACCEPTED** |

### 4. Parallel Synthesis Speedup (Web Workers)
* **Single-threaded throughput:** Up to **$148\times$ faster than real time** (Kick: $67\text{ ms}$ for $10\text{ s}$ audio; Grand Piano: $180\text{ ms}$).
* **Multi-threaded scaling:** For a 3-minute, 13-instrument orchestral composition ($7.93 \times 10^6$ samples), compilation dropped from **$22.2\text{ s}$** (single thread) to **$3.6\text{ s}$** (multi-threaded), achieving a **$6.17\times$ speedup**.

---

## 🛠️ Tech Stack

* **Core Desktop Shell:** [Tauri v2](https://tauri.app/) (Rust 1.99+)
* **Audio Synthesis & Scheduling:** Modern JavaScript (ES Modules), Web Audio API (`AudioContext`, `AudioBufferSourceNode`, `AnalyserNode`, `OfflineAudioContext`)
* **Multi-Threading:** Multi-core Web Workers (`render-worker.js`)
* **Signal Processing:** Custom Cooley-Tukey Radix-2 FFT, Parabolic Log-Magnitude Interpolation, Short-Time Fourier Transform (STFT)
* **Security & Grammar:** Domain-Specific Recursive-Descent AST Compiler (Strict sandbox: No `eval`, No `Function`, No prototype access)
* **Generative AI:** Google Gemini API (`gemini-3.5-flash`), Groq, OpenRouter, or Ollama (offline local)

---

## 🚀 Getting Started

### Prerequisites
* [Node.js](https://nodejs.org/) (v18 or higher)
* [Rust](https://rustup.rs/) (v1.75 or higher)
* C++ Build Tools (Visual Studio C++ build tools on Windows)
* WebView2 (pre-installed on Windows 10/11)

### 1. Installation
Clone the repository and install dependencies:
```bash
git clone https://github.com/Veeresh-MR/Music-Quest-Studio.git
cd Music-Quest-Studio
npm install
```

### 2. Running in Developer Mode
Launch the application with live hot-reloading:
```bash
npm run dev
```

### 3. Running Verification Tests
Execute the full automated test suite (parser checks, reference tones, sensitivity tests, and all 35 instruments):
```bash
npm test
```

### 4. Building the Production Installer
Compile the standalone desktop executable and Windows installer:
```bash
npm run build
```
The compiled installer will be located at:
```
src-tauri/target/release/bundle/nsis/Quest Studio_0.1.0_x64-setup.exe
```

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Description |
| :--- | :--- |
| `Space` | Play / Pause playback |
| `L` | Toggle Pattern (PAT) / Full Song (SONG) playback mode |
| `F5` | Open **Playlist Arrangement Window** |
| `F6` | Open **Channel Rack Window** |
| `F7` | Open **Piano Roll Window** |
| `F8` | Open **Formula Lab Window** (Live proof & verification) |
| `F9` | Open **Master Mixer & DSP Effects Rack** |
| `F10` | Open **AI Music Composer Window** |
| `F4` | Open **Graph Song Mode** |
| `Ctrl + N` | New project |
| `Ctrl + S` | Save project file (`.quest`) |
| `Ctrl + O` | Open project file |
| `Ctrl + R` | Export 16-bit lossless WAV audio |
| `Ctrl + Z` / `Ctrl + Y` | Multi-level Undo / Redo |

---

## 📁 Repository Structure

```
Music-Quest-Studio/
├── demos/                     # Pre-rendered math song demos (.quest, .wav, .mp4)
├── docs/                      # Research paper generator, results.json, and references
│   ├── Quest_Studio_Research_Paper.pdf  # Full IEEE conference research paper
│   ├── results.json           # Raw experimental data and verification benchmarks
│   ├── make_paper.py          # Automated ReportLab PDF generator
│   └── references.py          # 22 validated citations
├── scripts/                   # Tauri CLI runner script
├── src/                       # Frontend application source
│   ├── js/
│   │   ├── ai.js              # Gemini prompt orchestration & Self-Refine parser loop
│   │   ├── engine.js          # Web Audio API context, mixer strips, playback scheduler
│   │   ├── formula.js         # Safe mathematical lexer, AST parser & closure compiler
│   │   ├── graph.js           # Graph Song mode calculation & waveform rendering
│   │   ├── io.js              # File dialogs and native Tauri IPC bridges
│   │   ├── main.js            # Main application UI, menus, tabs, and modal controllers
│   │   ├── project.js         # Project state serialization, history, and autosave
│   │   ├── render-worker.js   # Background Web Worker for multi-threaded rendering
│   │   ├── synth.js           # 35-instrument factory library & sample generator
│   │   ├── verify.js          # Hermann C1-C4 verification engine (FFT, re-compute, STFT)
│   │   ├── video.js           # Lossless MP4 video exporter
│   │   └── wav.js             # 16-bit PCM WAV audio encoder
│   ├── views/                 # Modular UI screens (rack, playlist, pianoroll, lab, mixer, composer)
│   ├── index.html             # Studio main interface markup
│   └── styles.css             # FL Studio dark theme CSS
├── src-tauri/                 # Rust desktop backend (Tauri v2)
│   ├── src/
│   │   ├── lib.rs             # Native file access, dialogs, and safe AI HTTP proxy
│   │   └── main.rs            # Desktop application entry point
│   ├── Cargo.toml             # Rust package manifest
│   └── tauri.conf.json        # Tauri window and build configuration
├── tests/
│   ├── run.js                 # Complete test runner (npm test)
│   └── measure.mjs            # Benchmark script measuring scientific accuracy
├── Quest_Studio_Project_Report.pdf # Comprehensive academic project documentation
├── package.json
└── README.md
```

---

## 👨‍💻 Author & Contributor

* **VEERESH M R**  
  *USN: 1MS23CS210*  
  *Department of Computer Science and Engineering*  
  *Ramaiah Institute of Technology, Bangalore, India*  
  *GitHub:* [@Veeresh-MR](https://github.com/Veeresh-MR)

---

## 📜 Academic Citation

If you use Quest Studio or its verification methodology in your academic research, please cite:

```bibtex
@inproceedings{veeresh2026queststudio,
  author    = {Veeresh M R},
  title     = {Quest Studio: Verifiable Formula-to-Audio Generation in an LLM-Assisted Music Studio},
  booktitle = {Proceedings of the International Conference on Auditory Display and Computer Music},
  year      = {2026},
  publisher = {Department of Computer Science and Engineering, Ramaiah Institute of Technology}
}
```

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.
