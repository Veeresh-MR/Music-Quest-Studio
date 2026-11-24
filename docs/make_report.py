"""Builds Quest_Studio_Project_Report.pdf (project proposal with IEEE-style references).

Run:  pip install reportlab   then   python docs/make_report.py
Citations are numbered automatically in order of first use.
"""
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (KeepTogether, ListFlowable, ListItem, Paragraph,
                                SimpleDocTemplate, Spacer, Table, TableStyle)

OUT = Path(__file__).resolve().parent.parent / "Quest_Studio_Project_Report.pdf"

# Arial (Windows) covers accented author names such as Kudłacik; the built-in PDF fonts do not.
FONTS = Path("C:/Windows/Fonts")
for name, file in [("Body", "arial.ttf"), ("Body-Bold", "arialbd.ttf"), ("Body-Italic", "ariali.ttf"), ("Body-BoldItalic", "arialbi.ttf")]:
    pdfmetrics.registerFont(TTFont(name, str(FONTS / file)))
pdfmetrics.registerFontFamily("Body", normal="Body", bold="Body-Bold", italic="Body-Italic", boldItalic="Body-BoldItalic")

from references import REFS  # noqa: E402  (shared with make_paper.py)

order = []


def cite(*keys):
    """Returns '[n]' / '[n, m]' and numbers references in order of first use."""
    nums = []
    for k in keys:
        if k not in REFS:
            raise KeyError(k)
        if k not in order:
            order.append(k)
        nums.append(order.index(k) + 1)
    return "[" + ", ".join(str(n) for n in sorted(nums)) + "]"


# ---------------------------------------------------------------- styles
INK = colors.HexColor("#1a1d24")
MUTED = colors.HexColor("#5b6270")
ACCENT = colors.HexColor("#d9480f")
RULE = colors.HexColor("#e3e6ea")
HEAD_BG = colors.HexColor("#1f2430")
ROW_ALT = colors.HexColor("#f6f7f9")

s_kicker = ParagraphStyle("k", fontName="Body", textColor=ACCENT, fontSize=9, leading=12, alignment=TA_CENTER, spaceAfter=6)
s_title = ParagraphStyle("t", fontName="Body-Bold", textColor=INK, fontSize=20, leading=25, alignment=TA_CENTER, spaceAfter=4)
s_sub = ParagraphStyle("st", fontName="Body", textColor=MUTED, fontSize=11, leading=15, alignment=TA_CENTER)
s_h = ParagraphStyle("h", fontName="Body-Bold", textColor=INK, fontSize=13, leading=17, spaceBefore=14, spaceAfter=6, keepWithNext=1)
s_h2 = ParagraphStyle("h2", fontName="Body-Bold", textColor=INK, fontSize=11, leading=14, spaceBefore=10, spaceAfter=5)
s_body = ParagraphStyle("b", fontName="Body", textColor=INK, fontSize=10.5, leading=15.5, alignment=TA_JUSTIFY)
s_lead = ParagraphStyle("lead", fontName="Body", textColor=INK, fontSize=10.5, leading=15.5, spaceAfter=6)
s_bullet = ParagraphStyle("bl", fontName="Body", textColor=INK, fontSize=10.5, leading=15)
s_cell = ParagraphStyle("c", fontName="Body", textColor=INK, fontSize=9.5, leading=13)
s_cellh = ParagraphStyle("ch", fontName="Body-Bold", textColor=colors.white, fontSize=9.5, leading=13)
s_ref = ParagraphStyle("r", fontName="Body", textColor=INK, fontSize=9, leading=12.5, leftIndent=22, firstLineIndent=-22, spaceAfter=4)


def heading(num, text):
    return Paragraph(f'<font color="#d9480f">{num}.</font>&nbsp;&nbsp;{text}', s_h)


def bullets(items):
    return ListFlowable([ListItem(Paragraph(t, s_bullet), leftIndent=12) for t in items],
                        bulletType="bullet", start="•", leftIndent=12, bulletFontSize=9, bulletColor=ACCENT, spaceBefore=2)


def table(header, rows, widths):
    data = [[Paragraph(x, s_cellh) for x in header]] + [[Paragraph(c, s_cell) for c in r] for r in rows]
    t = Table(data, colWidths=widths, repeatRows=1)
    style = [("BACKGROUND", (0, 0), (-1, 0), HEAD_BG), ("VALIGN", (0, 0), (-1, -1), "TOP"),
             ("LINEBELOW", (0, 0), (-1, -1), 0.5, RULE), ("TOPPADDING", (0, 0), (-1, -1), 6),
             ("BOTTOMPADDING", (0, 0), (-1, -1), 6), ("LEFTPADDING", (0, 0), (-1, -1), 7), ("RIGHTPADDING", (0, 0), (-1, -1), 7)]
    style += [("BACKGROUND", (0, i), (-1, i), ROW_ALT) for i in range(2, len(data), 2)]
    t.setStyle(TableStyle(style))
    return t


W = A4[0] - 40 * mm
story = []

# 1. Title
story += [
    Paragraph("GENERATIVE AI PROJECT REPORT", s_kicker),
    Paragraph("Quest Studio", s_title),
    Paragraph("An AI-Powered Music Studio for Verifiable Formula-to-Audio Generation", s_sub),
    Spacer(1, 10),
]

# 2. Abstract
story += [
    heading(2, "Abstract"),
    Paragraph(
        "Today, music creation tools are either professional studios that need paid licences and advanced skills, "
        "or AI music generators that work as a black box and hide how each sound is made. This project proposes "
        "<b>Quest Studio</b>, a desktop music production studio in which every sound is created from a mathematical "
        "formula. The user can type a formula directly, or describe a sound or a whole song in plain words, which a "
        f"Large Language Model (LLM) converts into formulas {cite('brown', 'gemini')}. The system computes the audio "
        "directly from the formula 44,100 times per second, shows the formula's graph and spectrum in real time, and "
        "proves that the audio is correct by recomputing every sample independently and by comparing the frequencies "
        "predicted by the formula with the frequencies measured in the generated audio using the Fast Fourier Transform "
        f"(FFT) {cite('fft')}, following the four sonification conditions defined by Hermann {cite('hermann')}. "
        "Verified sounds are placed on tracks and mixed to compose songs in styles such as phonk, funk, lo-fi and "
        "Indian devotional music, and exported as WAV audio or MP4 video. The system will be evaluated through "
        "numerical accuracy tests and a listening study with users.", s_body),
]

# 3. Existing systems
story += [
    heading(3, "Existing Systems"),
    bullets([
        "<b>Professional music studios (DAWs)</b> such as Ableton Live and Logic Pro: complete song-making tools, but "
        "they need paid licences and a long learning time. Sounds come from presets and samples; there is no way to "
        "create a sound from a formula or check it mathematically.",
        "<b>Free web studios</b> such as BandLab: free and run in the browser, but they offer no formula-based sound "
        "design and no verification of sounds.",
        f"<b>AI music generators</b> such as Suno and Udio (commercial), and MusicGen {cite('copet')} and "
        f"MusicLM {cite('musiclm')} (research): create full songs from text prompts, but work as a black box. Users "
        "cannot see or control how each sound is made, there is no proof of what the sound contains, and usage rights "
        "depend on each provider's terms.",
        f"<b>Code-based music tools</b> such as Sonic Pi, SuperCollider and \"bytebeat\" {cite('heikkila')}: make sound "
        "from code or formulas, but need programming knowledge and lack a visual studio with tracks, mixing and "
        "verification.",
        f"<b>Sonification and audio-graph research</b>, such as Sound Graphs {cite('mansur')}, vowel-based function "
        f"sonification {cite('grond')} and adaptive sonification of function graphs {cite('dobosz')}, turns graphs "
        f"and data into sound, mainly to help people understand data {cite('kramer', 'handbook')}. These systems are "
        "not designed to compose, mix or export music.",
        "<b>Gap:</b> no existing system combines formula-to-sound generation, proof of audio correctness, AI "
        "prompt-to-formula generation and a full music studio in one free tool.",
    ]),
]

# 4. Proposed system
story += [
        heading(4, "Proposed System"),
        Paragraph("Quest Studio is a single desktop studio made of six connected modules:", s_lead),
        Spacer(1, 6),
        table(["Module", "What it does"], [
            ["<b>Formula Engine</b>", "Turns any typed formula into audio by calculating it 44,100 times per second, "
             f"using one clear and fixed rule, the classic approach of computer music {cite('mathews')}. A safe "
             "parser accepts only mathematics, never program code."],
            ["<b>Proof Panel (Verification)</b>", "Shows, for every sound, whether the audio matches its formula: "
             f"Hermann's four conditions {cite('hermann')}, the measured spectrum against the predicted frequencies, "
             "and the numerical error. Details in the table below."],
            ["<b>Live Graph</b>", "Draws the formula's waveform and spectrum while it plays, with a moving marker "
             "showing the part currently being heard."],
            ["<b>AI Prompt-to-Formula</b>", "The user describes a sound or song in plain words (for example, \"deep "
             f"punchy kick\"); an LLM through a free API {cite('gemini')} writes the formulas using worked examples in "
             f"the prompt {cite('brown')}. Invalid formulas are sent back to the model with the error for one repair "
             f"round {cite('selfrefine')}, and every result is verified before use."],
            ["<b>Music Studio</b>", "Channel rack, piano roll, playlist, mixer, reverb and limiter. Instruments include "
             f"FM keys and bells {cite('chowning')} and Indian instruments (tanpura, tabla, dhol, gejje, shehnai), "
             "all written as formulas."],
            ["<b>Export</b>", "Renders the finished song as a WAV audio file or an MP4 video with a visualizer."],
        ], [42 * mm, W - 42 * mm]),
        Spacer(1, 4),
        Paragraph("How the audio is proven correct", s_h2),
        table(["Check", "What the system does", "Basis"], [
            ["<b>1. Fixed rule</b> (C2)", "Sample n is exactly F(t = n / 44,100). A tone below 22,050 Hz is represented "
             "exactly at this rate; sharper sounds are flagged because their highest harmonics fold back (aliasing).",
             f"Sampling theorem {cite('nyquist', 'shannon')}; aliasing {cite('stilson')}"],
            ["<b>2. Independent recalculation</b> (C1)", "A second, separate evaluator recomputes every sample. Each "
             "sample must agree within float32 rounding (about 1 part in 16 million).", f"Hermann C1 {cite('hermann')}"],
            ["<b>3. Frequency match</b> (C1)", "Frequencies are predicted from the formula itself (including harmonics "
             "and FM sidebands) and compared with an FFT of the audio, in both directions: every predicted tone must be "
             "found, and every strong peak must be explained. Pitch glides are tracked frame by frame.",
             f"FFT {cite('fft')}; FM spectra {cite('chowning')}"],
            ["<b>4. Reproducibility</b> (C3)", "The sound is rendered twice and must be bit-identical (shown as a "
             "fingerprint).", f"Hermann C3 {cite('hermann')}"],
            ["<b>5. Same path for every formula</b> (C4)", "User, AI and built-in formulas all use the same parser and "
             "renderer; nothing is pre-recorded.", f"Hermann C4 {cite('hermann')}"],
            ["<b>6. Self-test</b>", "Automated tests feed the verifier deliberately wrong audio (a 450 Hz tone labelled "
             "as 440 Hz, a single altered sample, a wrong FM ratio); it must reject all of them.", "Negative testing"],
            ["<b>7. Listening study</b> (planned)", "Users match sounds to their graphs and rate quality.",
             f"{cite('walker', 'flowers', 'grond', 'fan', 'itu')}"],
        ], [38 * mm, W - 38 * mm - 42 * mm, 42 * mm]),
    Spacer(1, 8),
    bullets([
        "<b>Technology:</b> desktop app built with Tauri (Rust) and HTML, CSS and JavaScript with the Web Audio API; "
        "small and fast to open; free and open-source tools only.",
        "<b>Music styles:</b> phonk, funk, lo-fi, sad, happy, cinematic and Indian devotional music, built from "
        "formula sounds.",
        "<b>Advantages over existing systems:</b> every sound is transparent (its formula is visible), correctness "
        "is proven inside the app, AI makes it easy for beginners, and it is free to use.",
    ]),
]

# 5. Objectives
objectives = [
    "To design a system that converts any user-given mathematical formula into audio using direct sample-by-sample "
    "computation.",
    f"To verify the correctness of the generated audio using FFT-based frequency analysis {cite('fft')} and the four "
    f"sonification conditions of Hermann {cite('hermann')}.",
    "To provide real-time visualization of the formula, synchronized with its audio output.",
    f"To use a Large Language Model (LLM) to generate mathematical sound formulas from natural-language descriptions "
    f"{cite('brown')}.",
    "To integrate formula-generated sounds into a multi-track music studio with mixing and WAV/MP4 export.",
    f"To evaluate the system through numerical accuracy tests, listening tests {cite('walker', 'itu')} and usability "
    "feedback from users.",
]
story += [KeepTogether([
    heading(5, "Objectives of the Project"),
    ListFlowable([ListItem(Paragraph(t, s_bullet), leftIndent=16) for t in objectives],
                 bulletType="1", leftIndent=16, bulletFontName="Body-Bold", bulletColor=ACCENT, bulletFontSize=10.5),
])]

# 6. References (in order of first citation)
unused = [k for k in REFS if k not in order]
if unused:
    raise SystemExit(f"References never cited: {unused}")
ref_items = [Paragraph(f"[{i + 1}]&nbsp;&nbsp;{REFS[k]}", s_ref) for i, k in enumerate(order)]
story += [KeepTogether([heading(6, "References"), ref_items[0]]), *ref_items[1:]]


def on_page(c, doc):
    c.saveState()
    c.setStrokeColor(ACCENT)
    c.setLineWidth(2)
    c.line(20 * mm, A4[1] - 14 * mm, A4[0] - 20 * mm, A4[1] - 14 * mm)
    c.setFont("Body", 8)
    c.setFillColor(MUTED)
    c.drawString(20 * mm, 12 * mm, "Quest Studio — Generative AI Project Report")
    c.drawRightString(A4[0] - 20 * mm, 12 * mm, f"Page {doc.page}")
    c.restoreState()


doc = SimpleDocTemplate(str(OUT), pagesize=A4, leftMargin=20 * mm, rightMargin=20 * mm, topMargin=22 * mm,
                        bottomMargin=20 * mm, title="Quest Studio - Generative AI Project Report",
                        author="Quest Studio Team")
doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
print(f"written {OUT} with {len(order)} references")
