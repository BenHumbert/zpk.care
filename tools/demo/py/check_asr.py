"""Listens back to the walkthrough's speech clips with faster-whisper (small.en, CPU int8) to catch garbled or missing
words, repeats and inline cues read aloud, and saves each clip's word times for the whiteboard's { word } cues. It
cannot judge tone, accent or how a laugh sounds: it is a first pass before a listen.

Copied from Z:/ByteStreetCustomBeta/.tools/tts/check_asr.py and adapted for zpk.care: the model and ffmpeg come from
ZPK_DEMO_TOOLS (default Z:/ByteStreetCustomBeta/.tools), the spoken forms are the zpk ones (NDC, PCP, NADAC, Merkle
read as "merkel", zk, o1js, Ed25519...), and the word times whisper already computes are written out.

usage: <tools>/tts/venv-asr/Scripts/python.exe -I check_asr.py demo-out/voice-check/narrator [demo-out/voice-check/hr ...]
The intended text of each WAV comes from DIR/timings.json (written by voice-check.mjs); DIR/asr.json gets the result,
and <source clip>.words.json (or <wav>.words.json when timings.json names no source) gets the word times:
[{"word": "...", "startMs": 0, "endMs": 0}], measured from the start of the clip.
"""
import json
import os
import re
import subprocess
import sys
from difflib import SequenceMatcher
from pathlib import Path

import numpy as np
from faster_whisper import WhisperModel

TOOLS = Path(os.environ.get("ZPK_DEMO_TOOLS") or "Z:/ByteStreetCustomBeta/.tools")
MODEL = TOOLS / "tts" / "models" / "faster-whisper-small.en"
FFMPEG = TOOLS / "ffmpeg" / "bin" / "ffmpeg.exe"  # decodes to 16 kHz itself (the PyAV path is version-fragile)
PAD_S = 0.5  # load16k pads each side; word times are reported without it
TAG = re.compile(r"<\s*([A-Za-z_]+)\s*>")
SOUND = re.compile(r"[\(\[\*]([^\)\]\*]+)[\)\]\*]")  # whisper's own notes for non-speech, e.g. (laughs) [sighs]
# spoken forms -> one canonical token, applied to both the script and the transcript so they compare word for word
SPOKEN = [
    (r"\bn d cs?\b", "ndc"), (r"\bp c p\b", "pcp"), (r"\bh r\b", "hr"), (r"\bn f c\b", "nfc"), (r"\bn p i\b", "npi"),
    (r"\be i n\b", "ein"), (r"\br x\b", "rx"), (r"\bi ds?\b", "id"), (r"\bwallet i d\b", "wallet id"),
    (r"\bc p 575\b", "cp575"), (r"\bc p five seventy five\b", "cp575"), (r"\bcp 575\b", "cp575"),
    (r"\bmerkel\b", "merkle"), (r"\bnay dack\b", "nadac"), (r"\bnadak\b", "nadac"),
    (r"\bzee kay\b", "zk"), (r"\bz k\b", "zk"), (r"\boh one j s\b", "o1js"), (r"\bo 1 js\b", "o1js"), (r"\bo1 js\b", "o1js"),
    (r"\bed 25519\b", "ed25519"), (r"\be d 25519\b", "ed25519"), (r"\be d twenty five five nineteen\b", "ed25519"),
    (r"\bpo sigh don\b", "poseidon"), (r"\bposeidon's\b", "poseidon"),
    (r"\boop\b", "out of pocket"), (r"\be scripts?\b", "escript"), (r"\bescripts\b", "escript"),
    (r"\blayer two\b", "l2"), (r"\blayer 2\b", "l2"),
]


def norm(s):
    s = SOUND.sub(" ", TAG.sub(" ", s.lower())).replace("$", " ").replace("-", " ")
    s = " ".join(re.findall(r"[a-z0-9']+", s))
    for pat, rep in SPOKEN:
        s = re.sub(pat, rep, s)
    return s.split()


def repeats(heard, meant):
    """Word runs (2+ words) said twice in a row that the script does not repeat."""
    out = []
    for n in (4, 3, 2):
        for i in range(len(heard) - 2 * n + 1):
            run = heard[i:i + n]
            if run == heard[i + n:i + 2 * n] and " ".join(run * 2) not in " ".join(meant):
                out.append(" ".join(run))
    return sorted(set(out))


def load16k(wav):
    raw = subprocess.run([str(FFMPEG), "-v", "error", "-i", str(wav), "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    pad = np.zeros(int(16000 * PAD_S), dtype=np.float32)  # whisper drops words that start at sample 0
    return np.concatenate([pad, np.frombuffer(raw, dtype=np.float32), pad])


def main(dirs):
    model = WhisperModel(str(MODEL), device="cpu", compute_type="int8", cpu_threads=8)
    for d in map(Path, dirs):
        meta = json.loads((d / "timings.json").read_text(encoding="utf-8")) if (d / "timings.json").exists() else {}
        by_file = {r["file"]: r for r in meta.get("lines", [])}
        results = []
        for wav in sorted(d.glob("*.wav")):
            audio = load16k(wav)
            dur = len(audio) / 16000 - 2 * PAD_S
            segs, _ = model.transcribe(audio, language="en", beam_size=5, word_timestamps=True,
                                       condition_on_previous_text=False, vad_filter=False)
            ws = [w for s in segs for w in s.words]
            heard_text = "".join(w.word for w in ws).strip()
            line = by_file.get(wav.name, {})
            meant_text = line.get("text", "")
            heard, meant = norm(heard_text), norm(meant_text)
            tags = [t.lower() for t in TAG.findall(meant_text)]
            spoken_tags = [t for t in tags if any(h.startswith(t.split("_")[0]) for h in heard)
                           and not any(m.startswith(t.split("_")[0]) for m in meant)]
            words = [{"word": w.word.strip(), "startMs": max(0, round((w.start - PAD_S) * 1000)),
                      "endMs": max(0, round((w.end - PAD_S) * 1000))} for w in ws]
            target = Path(line["source"]) if line.get("source") else wav
            (target.parent / (target.name + ".words.json")).write_text(json.dumps(words, indent=1), encoding="utf-8")
            r = {"file": wav.name, "audio_s": round(dur, 2), "meant": meant_text, "heard": heard_text,
                 "match": round(SequenceMatcher(None, meant, heard).ratio(), 3) if meant else None,
                 "words_per_s": round(len(heard) / dur, 2) if dur else None,
                 "sound_notes": SOUND.findall(heard_text), "tags_maybe_read_aloud": spoken_tags,
                 "repeats": repeats(heard, meant),
                 "unclear_words": [f"{w.word.strip()} ({w.probability:.2f})" for w in ws if w.probability < 0.4]}
            results.append(r)
            print(f"{d.name}/{wav.name}  {dur:.2f}s  match {r['match']}  {r['words_per_s']} words/s")
            print(f"   meant: {meant_text}\n   heard: {heard_text}")
            for k in ("tags_maybe_read_aloud", "repeats", "unclear_words", "sound_notes"):
                if r[k]:
                    print(f"   {k}: {r[k]}")
        (d / "asr.json").write_text(json.dumps(results, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main(sys.argv[1:])
