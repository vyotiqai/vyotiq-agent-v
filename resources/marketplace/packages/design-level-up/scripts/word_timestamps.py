#!/usr/bin/env python3
"""word_timestamps.py - word-level transcript for transcript-to-motion-graphics (trick 24).

  python word_timestamps.py talk.mp4 [--model small] [--language en] [--outdir motion/] [--srt]
  python word_timestamps.py words.json [--outdir motion/] [--srt]     regroup an existing transcript
  python word_timestamps.py --selftest

Writes to --outdir (default: next to the input):
  words.json   [{"text": "Transcript", "start": 1.02, "end": 1.61}, ...]
               the plain word array HyperFrames also reads, so it can be imported there
  phrases.md   short timecoded phrases - read it to pick the moments that deserve a visual
  <name>.srt   subtitles built from the phrases (with --srt)

Needs one transcription engine (both free, MIT licensed):
  pip install faster-whisper       recommended: CPU friendly, decodes audio itself (no ffmpeg)
  pip install -U openai-whisper    needs ffmpeg on PATH
Models: tiny, base, small (default), medium, large-v3, turbo. Bigger = slower, more accurate.
Already using HyperFrames? `npx hyperframes transcribe audio.mp3` gives the same word array.
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path


# ------------------------------------------------------------------ engines
def transcribe_faster(path: Path, model: str, language: str | None, device: str, compute: str):
    from faster_whisper import WhisperModel  # type: ignore

    if device == "auto":
        try:
            import ctranslate2  # type: ignore  # installed with faster-whisper
            device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
        except Exception:
            device = "cpu"
    if compute == "auto":
        compute = "float16" if device == "cuda" else "int8"
    m = WhisperModel(model, device=device, compute_type=compute)
    segments, info = m.transcribe(str(path), language=language, word_timestamps=True, vad_filter=True)
    words = []
    for seg in segments:  # a generator: decoding happens while iterating
        for w in seg.words or []:
            words.append({"text": w.word.strip(), "start": round(w.start, 3), "end": round(w.end, 3)})
    return words, info.language, f"faster-whisper/{model} ({device}, {compute})"


def transcribe_openai(path: Path, model: str, language: str | None):
    import whisper  # type: ignore

    m = whisper.load_model(model)
    result = m.transcribe(str(path), language=language, word_timestamps=True)
    words = []
    for seg in result.get("segments", []):
        for w in seg.get("words", []):
            words.append({"text": w["word"].strip(), "start": round(w["start"], 3), "end": round(w["end"], 3)})
    return words, result.get("language"), f"openai-whisper/{model}"


def transcribe(path: Path, engine: str, model: str, language: str | None, device: str, compute: str):
    tried = []
    if engine in ("auto", "faster-whisper"):
        try:
            return transcribe_faster(path, model, language, device, compute)
        except ImportError:
            tried.append("faster-whisper")
            if engine == "faster-whisper":
                raise SystemExit("faster-whisper is not installed: pip install faster-whisper")
    if engine in ("auto", "openai-whisper"):
        try:
            return transcribe_openai(path, model, language)
        except ImportError:
            tried.append("openai-whisper")
    raise SystemExit(
        "No transcription engine found (tried: " + ", ".join(tried) + ").\n"
        "Install one:  pip install faster-whisper   (recommended)\n"
        "         or:  pip install -U openai-whisper  (needs ffmpeg)\n"
        "Or transcribe elsewhere and pass the resulting words.json to this script."
    )


# ------------------------------------------------------------------ shaping
def load_words(path: Path) -> list[dict]:
    """Accept a plain word array or a transcript object, with text/word keys."""
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict):
        data = data.get("words") or data.get("word_segments") or [
            w for seg in data.get("segments", []) for w in seg.get("words", [])
        ]
    words = []
    for w in data:
        text = str(w.get("text", w.get("word", ""))).strip()
        if text and w.get("start") is not None and w.get("end") is not None:
            words.append({"text": text, "start": float(w["start"]), "end": float(w["end"])})
    return words


def group_phrases(words: list[dict], max_gap: float = 0.35, max_words: int = 8, max_dur: float = 3.5) -> list[dict]:
    """Split the word stream at pauses, sentence ends and length limits."""
    phrases: list[dict] = []
    cur: list[dict] = []

    def flush() -> None:
        if cur:
            phrases.append({"start": cur[0]["start"], "end": cur[-1]["end"], "text": " ".join(w["text"] for w in cur)})
            cur.clear()

    for w in words:
        if cur:
            prev = cur[-1]
            gap = w["start"] - prev["end"]
            if (gap > max_gap or prev["text"][-1:] in ".?!;:" or len(cur) >= max_words
                    or w["end"] - cur[0]["start"] > max_dur or (prev["text"].endswith(",") and len(cur) >= 4)):
                flush()
        cur.append(w)
    flush()
    return phrases


def clock(t: float, srt: bool = False) -> str:
    ms_total = int(round(t * 1000))
    h, rem = divmod(ms_total, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    if srt:
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
    return (f"{h:d}:" if h else "") + f"{m:02d}:{s:02d}.{ms // 10:02d}"


def to_srt(phrases: list[dict]) -> str:
    return "\n".join(f"{i}\n{clock(p['start'], True)} --> {clock(p['end'], True)}\n{p['text']}\n"
                     for i, p in enumerate(phrases, 1))


def to_markdown(phrases: list[dict], source: str) -> str:
    lines = [f"# Phrases - {source}", "",
             "Pick the moments where a visual helps the viewer: numbers, lists, named tools or products,",
             "before/after, steps, a claim that needs proof. Skip filler. Each line: start - end (length) text.", ""]
    lines += [f"- [{clock(p['start'])} - {clock(p['end'])}] ({p['end'] - p['start']:.2f}s) {p['text']}" for p in phrases]
    return "\n".join(lines) + "\n"


def write_outputs(words: list[dict], outdir: Path, stem: str, source: str, srt: bool) -> list[Path]:
    outdir.mkdir(parents=True, exist_ok=True)
    phrases = group_phrases(words)
    out = [outdir / "words.json", outdir / "phrases.md"]
    out[0].write_text(json.dumps(words, ensure_ascii=False, indent=1), encoding="utf-8")
    out[1].write_text(to_markdown(phrases, source), encoding="utf-8")
    if srt:
        out.append(outdir / f"{stem}.srt")
        out[-1].write_text(to_srt(phrases), encoding="utf-8")
    return out


# ------------------------------------------------------------------ selftest
def selftest() -> int:
    words = [
        {"text": "Transcript", "start": 1.02, "end": 1.6}, {"text": "to", "start": 1.67, "end": 1.8},
        {"text": "motion", "start": 1.83, "end": 2.05}, {"text": "graphics.", "start": 2.08, "end": 2.6},
        {"text": "It", "start": 3.4, "end": 3.5}, {"text": "costs", "start": 3.52, "end": 3.8},
        {"text": "$29", "start": 3.82, "end": 4.3}, {"text": "a", "start": 4.32, "end": 4.4},
        {"text": "month,", "start": 4.42, "end": 4.8}, {"text": "and", "start": 4.85, "end": 4.95},
        {"text": "ships", "start": 4.97, "end": 5.3}, {"text": "today", "start": 5.32, "end": 5.7},
    ]
    phrases = group_phrases(words)
    texts = [p["text"] for p in phrases]
    assert texts[0] == "Transcript to motion graphics.", texts
    assert texts[1] == "It costs $29 a month,", texts
    assert texts[2] == "and ships today", texts
    assert clock(62.5) == "01:02.50" and clock(3725.04) == "1:02:05.04"
    assert to_srt(phrases[:1]).startswith("1\n00:00:01,020 --> 00:00:02,600\nTranscript to motion graphics.")
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "whisperx.json"
        src.write_text(json.dumps({"segments": [{"words": [{"word": " Hi", "start": 0.1, "end": 0.3},
                                                          {"word": "there", "start": 0.35, "end": 0.6}]}]}), encoding="utf-8")
        assert [w["text"] for w in load_words(src)] == ["Hi", "there"], "segment-style transcripts load"
        outs = write_outputs(words, Path(tmp) / "out", "talk", "talk.mp4", srt=True)
        assert all(p.exists() for p in outs) and len(outs) == 3
        again = load_words(outs[0])
        assert again == words, "words.json round-trips"
    print("selftest ok")
    return 0


# ------------------------------------------------------------------ cli
def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", nargs="?", type=Path, help="audio/video file, or an existing words.json")
    ap.add_argument("--model", default="small")
    ap.add_argument("--language", help="e.g. en; omit to auto-detect")
    ap.add_argument("--engine", choices=["auto", "faster-whisper", "openai-whisper"], default="auto")
    ap.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto", help="faster-whisper only")
    ap.add_argument("--compute-type", default="auto", help="faster-whisper only, e.g. int8, float16")
    ap.add_argument("--outdir", type=Path)
    ap.add_argument("--srt", action="store_true", help="also write subtitles")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)

    if args.selftest:
        return selftest()
    if not args.input or not args.input.exists():
        ap.error("give an audio/video file or a words.json that exists")
    outdir = args.outdir or args.input.parent
    if args.input.suffix.lower() == ".json":
        words, engine = load_words(args.input), "existing transcript"
    else:
        words, _lang, engine = transcribe(args.input, args.engine, args.model, args.language, args.device, args.compute_type)
    if not words:
        print("No words were recognised. Check the audio track, or pass --language.", file=sys.stderr)
        return 1
    outs = write_outputs(words, outdir, args.input.stem, args.input.name, args.srt)
    print(f"{len(words)} words via {engine}, {words[-1]['end']:.1f}s")
    for p in outs:
        print(f"  wrote {p}")
    print("Next: read phrases.md, pick the moments worth a visual, and write them to a cue sheet.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
