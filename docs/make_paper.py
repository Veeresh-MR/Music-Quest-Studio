"""Builds the research paper (IEEE-style two-column conference format).

Every number in the paper is read from docs/results.json, produced by `node tests/measure.mjs`.
Run:  pip install reportlab   then   python docs/make_paper.py
"""
import json
from pathlib import Path
from statistics import median

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, Frame, FrameBreak, KeepTogether, NextPageTemplate, PageTemplate,
                                Paragraph, Spacer, Table, TableStyle)

from references import REFS

HERE = Path(__file__).resolve().parent
OUT = HERE / "Quest_Studio_Research_Paper.pdf"
R = json.loads((HERE / "results.json").read_text(encoding="utf-8"))

FONTS = Path("C:/Windows/Fonts")
for name, file in [("Serif", "times.ttf"), ("Serif-Bold", "timesbd.ttf"), ("Serif-Italic", "timesi.ttf"), ("Serif-BoldItalic", "timesbi.ttf")]:
    pdfmetrics.registerFont(TTFont(name, str(FONTS / file)))
pdfmetrics.registerFontFamily("Serif", normal="Serif", bold="Serif-Bold", italic="Serif-Italic", boldItalic="Serif-BoldItalic")

order = []


def cite(*keys):
    nums = []
    for k in keys:
        if k not in REFS:
            raise KeyError(k)
        if k not in order:
            order.append(k)
        nums.append(order.index(k) + 1)
    return "[" + ", ".join(str(n) for n in sorted(nums)) + "]"


# ---------------------------------------------------------------- numbers from the measurements
inst = R["instruments"]
n_inst = len(inst)
n_pass = sum(i["verdict"] == "pass" for i in inst)
samples = sum(i["samples"] for i in inst)
num_fail = sum(i["numericFailures"] for i in inst)
max_abs = max(i["maxAbs"] for i in inst)
tones_measured = sum(i["tonesMeasured"] for i in inst)
max_tone_err = max(i["maxToneError"] for i in inst if i["maxToneError"] is not None)
peaks_ok = sum(i["peaksExplained"] for i in inst)
peaks_all = sum(i["peaksChecked"] for i in inst)
glides = [i for i in inst if i["sweep"] and i["sweep"]["medianRelError"] is not None]
known = R["knownTones"]
max_known = max(t["absError"] for t in known)
neg = R["negative"]
neg_bad = [n for n in neg if not n["case"].startswith("correct audio")]
control = next(n for n in neg if n["case"].startswith("correct audio"))
graph = R["graph"]
graph_measured = [g for g in graph if g["medianRelError"] is not None]
speed = R["speed"]

# ---------------------------------------------------------------- styles
BLACK = colors.black
GRID = colors.HexColor("#999999")
st_title = ParagraphStyle("title", fontName="Serif", fontSize=21, leading=25, alignment=TA_CENTER, spaceAfter=8)
st_author = ParagraphStyle("author", fontName="Serif", fontSize=10, leading=12.5, alignment=TA_CENTER)
st_abs = ParagraphStyle("abs", fontName="Serif-Bold", fontSize=9, leading=11, alignment=TA_JUSTIFY, spaceAfter=4)
st_body = ParagraphStyle("body", fontName="Serif", fontSize=9.6, leading=11.6, alignment=TA_JUSTIFY, firstLineIndent=10, spaceAfter=2)
st_body0 = ParagraphStyle("body0", parent=st_body, firstLineIndent=0)
st_h1 = ParagraphStyle("h1", fontName="Serif", fontSize=9.6, leading=12, alignment=TA_CENTER, spaceBefore=8, spaceAfter=4, keepWithNext=1)
st_h2 = ParagraphStyle("h2", fontName="Serif-Italic", fontSize=9.6, leading=12, spaceBefore=5, spaceAfter=2, keepWithNext=1)
st_eq = ParagraphStyle("eq", fontName="Serif-Italic", fontSize=9.6, leading=13, alignment=TA_CENTER, spaceBefore=3, spaceAfter=3)
st_cap = ParagraphStyle("cap", fontName="Serif", fontSize=8, leading=9.5, alignment=TA_CENTER, spaceBefore=4, spaceAfter=3)
st_cell = ParagraphStyle("cell", fontName="Serif", fontSize=7.8, leading=9.2)
st_cellh = ParagraphStyle("cellh", fontName="Serif-Bold", fontSize=7.8, leading=9.2)
st_ref = ParagraphStyle("ref", fontName="Serif", fontSize=7.8, leading=9.2, leftIndent=14, firstLineIndent=-14, spaceAfter=2.5)
st_bullet = ParagraphStyle("bul", parent=st_body, firstLineIndent=0, leftIndent=10, bulletIndent=2)

ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"]
sec_no = [0]


def section(title):
    sec_no[0] += 1
    return Paragraph(f"{ROMAN[sec_no[0] - 1]}. {title.upper()}", st_h1)


def sub(letter, title):
    return Paragraph(f"{letter}. {title}", st_h2)


def P(text, first=True):
    return Paragraph(text, st_body if first else st_body0)


tab_no = [0]


def table(caption, header, rows, widths):
    tab_no[0] += 1
    data = [[Paragraph(h, st_cellh) for h in header]] + [[Paragraph(str(c), st_cell) for c in r] for r in rows]
    t = Table(data, colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([("LINEABOVE", (0, 0), (-1, 0), 0.8, BLACK), ("LINEBELOW", (0, 0), (-1, 0), 0.5, BLACK),
                           ("LINEBELOW", (0, -1), (-1, -1), 0.8, BLACK), ("VALIGN", (0, 0), (-1, -1), "TOP"),
                           ("TOPPADDING", (0, 0), (-1, -1), 1.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 1.5),
                           ("LEFTPADDING", (0, 0), (-1, -1), 2.5), ("RIGHTPADDING", (0, 0), (-1, -1), 2.5)]))
    return KeepTogether([Paragraph(f"TABLE {ROMAN[tab_no[0] - 1]}<br/>{caption.upper()}", st_cap), t, Spacer(1, 4)])


def bullets(items):
    return [Paragraph(t, st_bullet, bulletText="\u2022") for t in items]


fmt_pct = lambda x: f"{x * 100:.3f}%" if x is not None else "n/a"
COL = (A4[0] - 2 * 16 * mm - 6 * mm) / 2  # column width

story = []
# ---------------------------------------------------------------- title block (full width)
story += [
    Paragraph("Quest Studio: Verifiable Formula-to-Audio Generation in an LLM-Assisted Music Studio", st_title),
    Paragraph("[Author 1], [Author 2], [Author 3]<br/><i>Department of [Department], [College Name], [City], India</i><br/>[email addresses]", st_author),
    Spacer(1, 6),
    FrameBreak(),
    NextPageTemplate("body"),
]

# ---------------------------------------------------------------- abstract
story += [
    Paragraph(
        "<i>Abstract</i>\u2014Sounds produced from mathematical formulas are increasingly shared as music, but a listener "
        "cannot tell whether the audio really is the formula that is shown. We present Quest Studio, a free desktop music "
        "studio in which every instrument, drum and melody is a formula, and in which every sound is verified against its "
        "formula. Verification follows the four sonification conditions of Hermann and combines (i) an independent "
        "re-computation of every sample, (ii) a two-way spectral test in which frequencies predicted symbolically from the "
        "formula (harmonics, frequency-modulation sidebands and aliasing) are compared with a Fast Fourier Transform of "
        "the audio, (iii) frame-wise pitch tracking for gliding tones, and (iv) a bit-exact reproducibility test. A "
        "graph mode renders \u201cgraphing-calculator songs\u201d by mapping a graph y = g(x) to pitch, and a Large Language "
        f"Model turns text prompts into validated formulas. On {n_inst} built-in instruments, {samples:,} samples were "
        f"re-computed with {num_fail} mismatches beyond float32 rounding and {peaks_ok} of {peaks_all} spectral peaks were "
        f"explained by the formulas; nine reference tones from 27.5 Hz to 18 kHz were measured within {max_known:.4f} Hz; "
        f"and all {len(neg_bad)} deliberately corrupted signals, including a single altered sample, were rejected while "
        "the correct signal was accepted.", st_abs),
    Paragraph("<i>Index Terms</i>\u2014sonification, sound synthesis, auditory display, verification, Fast Fourier "
              "Transform, large language models, computer music.", st_abs),
]

# ---------------------------------------------------------------- I. introduction
story += [
    section("Introduction"),
    P(f"Computers have generated music by evaluating numbers since the 1960s {cite('mathews')}. Today two very different "
      "kinds of tools dominate. Professional digital audio workstations build songs from presets and recorded samples, "
      f"and text-to-music models such as MusicGen {cite('copet')} and MusicLM {cite('musiclm')} generate whole songs from a "
      "prompt but give no insight into how each sound is produced. At the same time, short videos in which a song is "
      "\u201cjust math\u201d have become popular: a formula and its graph are shown while music plays. Whether the music "
      "is actually produced by the formula on screen cannot be checked by the viewer."),
    P(f"Sonification research gives a precise answer to what \u201cproduced by the data\u201d should mean. Hermann "
      f"{cite('hermann')} defines a technique as sonification only if (C1) the sound reflects objective properties of the "
      "input, (C2) the transformation is systematic and precisely defined, (C3) the result is reproducible, and (C4) the "
      "system works with different input. We use these conditions as a correctness specification for formula-generated "
      "audio and build a studio that checks them automatically for every sound."),
    P("The contributions of this work are:", True),
    *bullets([
        "A complete, free music studio (channel rack, piano roll, playlist, mixer, WAV/MP4 export) in which every sound is a "
        "formula evaluated by a safe parser, with a single published rendering rule.",
        "A verification method that maps Hermann\u2019s C1\u2013C4 to measurable tests: independent re-computation, a "
        "two-way symbolic-versus-FFT spectral test, pitch tracking and bit-exact reproducibility.",
        "A graph mode for graphing-calculator songs, in which a graph is heard as pitch and verified by pitch tracking.",
        "An LLM pipeline that writes formulas from text, validates them with the same parser and repairs invalid output.",
    ]),
]

# ---------------------------------------------------------------- II. related work
story += [
    section("Related Work"),
    sub("A", "Formula-based synthesis"),
    P(f"Mathews showed that a digital computer can act as a musical instrument by computing waveforms sample by sample "
      f"{cite('mathews')}. Chowning\u2019s frequency modulation (FM) produces rich spectra whose components lie at the carrier "
      f"plus integer multiples of the modulator {cite('chowning')}; we use this result to predict FM spectra. Stilson and "
      f"Smith analysed aliasing caused by discontinuous waveforms such as the sawtooth {cite('stilson')}. Very short "
      f"programs that output raw audio, known as bytebeat, show that a single expression can produce structured music "
      f"{cite('heikkila')}; such tools, however, provide neither a studio nor any verification."),
    sub("B", "Sonification and auditory graphs"),
    P(f"Mansur et al. introduced sound graphs, in which a curve is heard as varying pitch {cite('mansur')}. The field was "
      f"surveyed in the Sonification Report {cite('kramer')} and the Sonification Handbook {cite('handbook')}. Walker and "
      f"Kramer showed experimentally that the choice of data-to-sound mapping affects performance {cite('walker')}, and "
      f"Flowers reviewed pitfalls of auditory graphing {cite('flowers')}. Function sonification has been studied with "
      f"vowel-based synthesis {cite('grond')}, adaptive sonification of function graphs {cite('dobosz')} and the perception "
      f"of slope and acceleration in pitch-based sonification {cite('fan')}. These works study perception and accessibility; "
      "our focus is the verified correctness of the audio and its use for composing music."),
    sub("C", "Language models for generation"),
    P(f"Large language models can follow a task from a few worked examples in the prompt {cite('brown')}. We use the Gemini "
      f"family {cite('gemini')} through a free API, and return parser errors to the model for one repair round, in the "
      f"spirit of iterative self-refinement {cite('selfrefine')}."),
]

# ---------------------------------------------------------------- III. system design
story += [
    section("System Design"),
    sub("A", "Formula language"),
    P("A sound is one expression y = F(t, f, v), where t is the time since the note started in seconds, f the note "
      "frequency set by the piano roll and v the velocity. The language contains numbers, the constants \u03c0, \u03c4 = 2\u03c0 "
      "and e, arithmetic operators and a fixed set of functions (sin, cos, tanh, exp, saw, sqr, tri, frac, if, a "
      "reproducible noise function and others). Text is tokenized and parsed into an abstract syntax tree; it is never "
      "passed to a JavaScript evaluator, so a formula cannot execute program code. Names are looked up only among the "
      "language\u2019s own symbols, which also blocks prototype names such as <i>constructor</i>."),
    sub("B", "Rendering rule"),
    P("Sample n of a note with frequency f and velocity v is"),
    Paragraph("y[n] = F(n / f<sub>s</sub>, f, v),&nbsp;&nbsp;&nbsp;n = 0, 1, \u2026, N\u22121,&nbsp;&nbsp;&nbsp;(1)", st_eq),
    P("with f<sub>s</sub> = 44,100 Hz. One-shot sounds (drums) last for a fixed time; note sounds last for the note length "
      "plus a release during which a linear fade is applied, and the last 5 ms are faded to zero to prevent clicks. By "
      f"the sampling theorem {cite('nyquist', 'shannon')}, components below f<sub>s</sub>/2 = 22,050 Hz are represented "
      "exactly. For speed, parts of a formula that do not depend on t are computed once per note, and repeated "
      "time-dependent sub-expressions (for example one vibrato phase shared by eight harmonics) once per sample; both "
      "transformations leave every result bit-identical. Notes are rendered in parallel by background worker threads."),
    sub("C", "Graph mode"),
    P("In graph mode a layer is a graph y = g(x) in which x counts beats. The graph is heard as pitch, as in sound "
      f"graphs {cite('mansur')}:"),
    Paragraph("x[n] = n\u00b7B / (60 f<sub>s</sub>),&nbsp;&nbsp;f[n] = f<sub>0</sub>\u00b72<sup>g(x[n])</sup>,&nbsp;&nbsp;"
              "\u03c6[n+1] = \u03c6[n] + 2\u03c0 f[n] / f<sub>s</sub>,&nbsp;&nbsp;(2)", st_eq),
    P("where B is the tempo and f<sub>0</sub> the base note, so y = 1 is one octave and y = 1/12 one semitone. The output "
      "is s[n] = a\u00b7\u03b3[n]\u00b7w(\u03c6[n]) with volume a, waveform w and a gate \u03b3 that ramps to zero within 3 ms "
      "wherever g is undefined, which makes piecewise graphs (written with if and frac) audible exactly where they are "
      "drawn."),
    sub("D", "Studio and language-model assistance"),
    P("The studio provides a channel rack, piano roll, playlist, mixer with reverb and limiter, and export to 16-bit WAV "
      "and to MP4 video (AAC audio with a visualizer or the animated graph). It is a desktop application built with "
      "Tauri; file access is restricted to files the user selects in a native dialog. The language model receives the "
      "language specification and the instrument library, may reuse library instruments by name, and must return JSON. "
      "Every returned formula is validated by the parser; invalid formulas are sent back once for repair, and truncated "
      "or malformed answers are re-requested in compact form."),
]

# ---------------------------------------------------------------- IV. verification
story += [
    section("Verification Method"),
    sub("A", "Independent re-computation (C1)"),
    P("Rendering uses compiled closures. A second, independent path interprets the syntax tree directly in double "
      "precision. Because samples are stored as 32-bit floats, a correct sample may differ from the exact value by at "
      "most half a unit in the last place, so each sample must satisfy"),
    Paragraph("|y<sub>render</sub>[n] \u2212 y<sub>ref</sub>[n]| \u2264 2<sup>\u221224</sup>|y<sub>ref</sub>[n]|.&nbsp;&nbsp;&nbsp;(3)", st_eq),
    sub("B", "Two-way spectral test (C1)"),
    P(f"Every oscillator whose phase depends on t is located in the syntax tree. Its average frequency is the total phase "
      "change divided by the duration, which is unbiased even when a modulation depth decays. Oscillators inside another "
      "oscillator\u2019s phase are treated as modulators. The predicted set of spectral lines contains harmonics of each "
      "tone, FM sidebands n\u00b7f<sub>c</sub> + k\u00b7f<sub>m</sub> "
      f"{cite('chowning')} (also around slow vibrato), and harmonics of discontinuous waves folded at f<sub>s</sub>/2 "
      f"{cite('stilson')}. A Hann-windowed FFT {cite('fft')} with parabolic peak interpolation is then used in two "
      "directions: each predicted tone must be found within max(bin width, 0.2%), and each of the strongest peaks "
      "(within 30 dB of the maximum) must be explained by a predicted line. Tones closer than the window\u2019s frequency "
      "resolution are reported as not separable rather than as failures."),
    sub("C", "Pitch tracking"),
    P("For gliding tones and for graph mode, a short-time FFT measures the pitch frame by frame. The frame length is "
      "chosen to contain at least four cycles of the tone, and the prediction for a frame is the window-weighted mean of "
      "the instantaneous frequency. A frame is measured only if the pitch changes by less than a semitone inside it; the "
      "median relative error must not exceed 2\u20133%."),
    sub("D", "Reproducibility and generality (C3, C4)"),
    P("Each sound is rendered twice and must be bit-identical (a fingerprint is shown). All formulas\u2014typed by the user, "
      "generated by the language model or built in\u2014pass through the same parser and the same rule (1) or (2)."),
]

# ---------------------------------------------------------------- V. results
group_rows = []
for group in dict.fromkeys(i["group"] for i in inst):
    g = [i for i in inst if i["group"] == group]
    tm = sum(i["tonesMeasured"] for i in g)
    errs = [i["maxToneError"] for i in g if i["maxToneError"] is not None]
    pk = sum(i["peaksChecked"] for i in g)
    gl = [i for i in g if i["sweep"] and i["sweep"]["medianRelError"] is not None]
    group_rows.append([group, len(g), f"{sum(i['samples'] for i in g):,}", sum(i["numericFailures"] for i in g),
                       f"{tm} ({max(errs):.2f} Hz)" if errs else "\u2014",
                       f"{sum(i['peaksExplained'] for i in g)}/{pk}" if pk else "\u2014",
                       len(gl) if gl else "\u2014", f"{sum(i['verdict'] == 'pass' for i in g)}/{len(g)}"])

story += [
    section("Experiments and Results"),
    P(f"All measurements were produced by a script included with the software (tests/measure.mjs) on an {R['machine']}, "
      f"single-threaded, at f<sub>s</sub> = {R['sampleRate']:,} Hz. Note instruments were analysed for 1.5 s at A3 (220 Hz); "
      "one-shot sounds for their full length."),
    sub("A", "Reference tones"),
    P(f"Table I lists pure tones of amplitude 0.5 and duration 1 s. All {len(known)} were found at the predicted "
      f"frequency; the largest absolute error was {max_known:.4f} Hz."),
    table("Reference tones: predicted vs. measured frequency",
          ["Predicted (Hz)", "Measured (Hz)", "Error (Hz)", "Result"],
          [[f"{t['hz']:g}", f"{t['measured']:.4f}", f"{t['absError']:.4f}", t["status"].upper()] for t in known],
          [COL * 0.27, COL * 0.27, COL * 0.24, COL * 0.22]),
    sub("B", "Built-in instruments"),
    P(f"Table II summarises the {n_inst} instruments by group. {n_pass} of {n_inst} passed all checks. Across "
      f"{samples:,} samples the independent re-computation found {num_fail} values outside the bound (3); the largest "
      f"absolute difference was {max_abs:.1e}. {tones_measured} predicted tones were measured (largest error "
      f"{max_tone_err:.2f} Hz), {peaks_ok} of {peaks_all} strongest spectral peaks were explained by the formulas, and "
      f"{len(glides)} gliding tones (kicks, 808, riser, tabla) were tracked with median errors up to "
      f"{fmt_pct(max(g['sweep']['medianRelError'] for g in glides))}. Noise-based sounds (snare, clap, crackle) have no "
      "pitch to predict and are verified by re-computation and reproducibility only."),
    table("Verification of the built-in instruments by group",
          ["Group", "N", "Samples", "Num. fail", "Tones (max err)", "Peaks", "Glide", "Pass"],
          group_rows, [COL * 0.16, COL * 0.05, COL * 0.15, COL * 0.1, COL * 0.2, COL * 0.12, COL * 0.1, COL * 0.12]),
    sub("C", "Detection of incorrect audio"),
    P("A verifier that always passes would be useless, so we supplied audio that does not match the formula it is "
      f"checked against. All {len(neg_bad)} corrupted cases in Table III were rejected, including a tone only 1 Hz off "
      f"and a single sample changed by 0.01 among 44,100, while the correct audio was {('accepted' if not control['rejected'] else 'REJECTED')}."),
    table("Negative tests", ["Audio supplied", "Expected", "Result"],
          [[n["case"], "accept" if n["case"].startswith("correct audio") else "reject",
            ("rejected" if n["rejected"] else "accepted")] for n in neg],
          [COL * 0.62, COL * 0.18, COL * 0.2]),
    sub("D", "Graph mode"),
    P(f"Table IV shows the four layers of an example graph song (8 bars at 140 BPM). All layers were re-computed without "
      f"mismatches. {len(graph_measured)} layers have pitch segments slow enough to be measured; their median pitch "
      "errors are listed. The kick and tick layers move by more than a semitone inside any analysis frame, so their "
      "pitch is reported as not measurable instead of being estimated."),
    table("Graph-mode verification of an example song",
          ["Layer", "Samples", "Num. fail", "Frames measured", "Median pitch error", "Result"],
          [[g["name"], f"{g['samples']:,}", g["numericFailures"], g["pitchFrames"], fmt_pct(g["medianRelError"]), g["verdict"].upper()] for g in graph],
          [COL * 0.15, COL * 0.17, COL * 0.13, COL * 0.17, COL * 0.22, COL * 0.16]),
    sub("E", "Speed"),
    P("Table V reports single-thread rendering speed as multiples of real time. In the desktop application, rendering "
      "is distributed over worker threads; for a 3-minute orchestral piece with 13 instruments, preparing all sounds "
      "took 22.2 s on one thread and 3.6 s with workers on the same 12-thread laptop (measured in Chromium)."),
    table("Single-thread rendering speed", ["Instrument", "ms per 10 s of audio", "\u00d7 real time"],
          [[s["name"], f"{s['msPer10s']:.0f}", f"{s['realtimeFactor']:.0f}"] for s in speed],
          [COL * 0.4, COL * 0.35, COL * 0.25]),
]

# ---------------------------------------------------------------- VI. discussion
story += [
    section("Discussion and Limitations"),
    P("The verification establishes that the audio is exactly what the formula specifies; it does not judge whether "
      "the result is musically good. A listening study is therefore planned: participants will match sounds to their "
      f"graphs, following earlier auditory-graph studies {cite('walker', 'grond', 'fan')}, and rate quality with the "
      f"MUSHRA method {cite('itu')}. Pitch tracking cannot measure tones whose pitch changes by more than a semitone "
      "within a frame, and noise has no predictable spectrum; both cases are reported explicitly rather than counted as "
      "passes. Products of two audio-rate oscillators (ring modulation) are not yet predicted. Discontinuous waveforms "
      f"alias {cite('stilson')}; the system warns about this but does not yet apply band-limited synthesis. Finally, the "
      "quality of language-model output depends on the model and on free-tier availability; the system therefore treats "
      "model output as untrusted input and verifies it like any other formula."),
]

# ---------------------------------------------------------------- VII. conclusion
story += [
    section("Conclusion"),
    P("Quest Studio shows that formula-generated music can be made verifiable inside a practical studio. By turning "
      "Hermann\u2019s definition of sonification into automatic tests, every sound\u2014built in, typed by a user or "
      "written by a language model\u2014comes with evidence that it is exactly what its formula describes. Future work "
      "includes the listening study, band-limited oscillators, prediction of ring-modulation spectra and a plug-in "
      "version for existing music software."),
]

# ---------------------------------------------------------------- references
unused = [k for k in REFS if k not in order]
if unused:
    raise SystemExit(f"References never cited: {unused}")
story += [Paragraph("REFERENCES", st_h1)]
story += [Paragraph(f"[{i + 1}]&nbsp;{REFS[k]}", st_ref) for i, k in enumerate(order)]

# ---------------------------------------------------------------- layout: IEEE-like two columns
M, GAP = 16 * mm, 6 * mm
W, H = A4
TITLE_H = 44 * mm
first = PageTemplate(id="first", frames=[
    Frame(M, H - M - TITLE_H, W - 2 * M, TITLE_H, id="title", showBoundary=0),
    Frame(M, M, COL, H - 2 * M - TITLE_H, id="c1"),
    Frame(M + COL + GAP, M, COL, H - 2 * M - TITLE_H, id="c2"),
])
body = PageTemplate(id="body", frames=[Frame(M, M, COL, H - 2 * M, id="l"), Frame(M + COL + GAP, M, COL, H - 2 * M, id="r")],
                    onPage=lambda c, d: (c.setFont("Serif", 8), c.drawCentredString(W / 2, 9 * mm, str(d.page))))
doc = BaseDocTemplate(str(OUT), pagesize=A4, pageTemplates=[first, body], title="Quest Studio: Verifiable Formula-to-Audio Generation",
                      author="[Authors]")
doc.build(story)
print(f"written {OUT} ({len(order)} references)")
