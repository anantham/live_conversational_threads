"""Standalone Kokoro TTS render worker — runs in the `whisperlocal` env (py3.10).

Invoked by tts.py via subprocess:
    python _kokoro_worker.py <spec.json> <out.wav> <manifest.json>

Reads a render-spec (turns + per-turn voice + timing config), renders each turn
with its assigned Kokoro voice, lays the utterances on a single timeline (with
inter-turn pauses, optional overlap, optional noise), and writes a wav plus a
per-turn timing manifest the diarization scorer consumes. Self-contained: imports
only kokoro + numpy + soundfile + torch (all present in whisperlocal).
"""

import json
import sys

import numpy as np
import soundfile as sf
import torch
from kokoro import KPipeline


def render(spec_path: str, out_path: str, manifest_path: str) -> None:
    with open(spec_path, encoding="utf-8") as fh:
        spec = json.load(fh)

    sr = int(spec.get("sample_rate", 24000))
    pause = float(spec.get("pause_ms", 300)) / 1000.0
    overlap = float(spec.get("overlap_ms", 0)) / 1000.0
    speed = float(spec.get("speed", 1.0))
    noise_db = spec.get("noise_db")
    pipe = KPipeline(lang_code=spec.get("lang_code", "a"))

    # 1) Render each turn to a mono float32 array.
    utterances = []  # (turn_id, speaker, np.float32[])
    for turn in spec["turns"]:
        chunks = []
        for _gs, _ps, audio in pipe(turn["text"], voice=turn["voice"], speed=speed):
            arr = audio.detach().cpu().numpy() if isinstance(audio, torch.Tensor) else np.asarray(audio)
            chunks.append(arr.astype(np.float32))
        utt = np.concatenate(chunks) if chunks else np.zeros(1, np.float32)
        utterances.append((turn["id"], turn.get("speaker", ""), utt))

    # 2) Compute each turn's start time: prev_end + pause - overlap.
    starts = []
    cursor = 0.0
    for i, (_tid, _spk, utt) in enumerate(utterances):
        start = 0.0 if i == 0 else max(0.0, cursor + pause - overlap)
        starts.append(start)
        cursor = start + len(utt) / sr

    # 3) Mix onto one timeline (add, so overlap blends rather than truncates).
    total_samples = int(round(cursor * sr)) + int(0.2 * sr)
    timeline = np.zeros(max(total_samples, 1), np.float32)
    manifest = {"sample_rate": sr, "turns": {}, "speakers": {}}
    for (tid, spk, utt), start in zip(utterances, starts):
        s = int(round(start * sr))
        e = s + len(utt)
        if e > len(timeline):
            timeline = np.pad(timeline, (0, e - len(timeline)))
        timeline[s:e] += utt
        manifest["turns"][tid] = [round(start, 3), round(start + len(utt) / sr, 3)]
        manifest["speakers"][tid] = spk

    # 4) Optional gaussian noise (stress knob), seeded for reproducibility.
    if noise_db is not None:
        amp = 10 ** (float(noise_db) / 20.0)
        rng = np.random.default_rng(0)
        timeline = timeline + rng.standard_normal(len(timeline)).astype(np.float32) * amp

    # 5) Normalize to avoid clipping.
    peak = float(np.max(np.abs(timeline))) if timeline.size else 1.0
    if peak > 1.0:
        timeline = timeline / peak * 0.98

    sf.write(out_path, timeline, sr)
    with open(manifest_path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
    print("RENDER_OK turns=%d dur=%.2fs sr=%d -> %s" % (len(utterances), len(timeline) / sr, sr, out_path))


if __name__ == "__main__":
    render(sys.argv[1], sys.argv[2], sys.argv[3])
