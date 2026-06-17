"""WhisperX transcription + diarization worker — runs in the `whisperlocal` env.

Invoked by stt.py:  python _whisperx_worker.py <spec.json> <out.json>

spec:  {wav_path, model, compute_type, language, batch_size, diarize,
        min_speakers, max_speakers}
out:   {ok, language, text, segments:[{start,end,text,speaker}],
        words:[{word,start,end,speaker}], warnings, error}

Frees the ASR model before align/diarize so large-v3 + align + pyannote don't
stack VRAM (the GPU is shared with LM Studio). Align/diarize failures degrade to
warnings rather than aborting transcription.
"""

import gc
import json
import os
import sys
import traceback


def run(spec_path: str, out_path: str) -> None:
    with open(spec_path, encoding="utf-8") as fh:
        spec = json.load(fh)
    out = {"ok": False, "warnings": []}
    try:
        import torch
        import whisperx

        device = "cuda" if torch.cuda.is_available() else "cpu"
        compute = spec.get("compute_type") or "int8"
        model_name = spec.get("model", "large-v3")
        audio = whisperx.load_audio(spec["wav_path"])

        model = whisperx.load_model(model_name, device, compute_type=compute, language=spec.get("language"))
        res = model.transcribe(audio, batch_size=int(spec.get("batch_size", 8)))
        lang = res.get("language", "en")
        del model
        gc.collect()
        try:
            torch.cuda.empty_cache()
        except Exception:
            pass

        # Word-level alignment.
        try:
            amodel, meta = whisperx.load_align_model(language_code=lang, device=device)
            res = whisperx.align(res["segments"], amodel, meta, audio, device, return_char_alignments=False)
            del amodel
            gc.collect()
            try:
                torch.cuda.empty_cache()
            except Exception:
                pass
        except Exception as exc:  # noqa: BLE001
            out["warnings"].append(f"align failed: {exc}")

        # Speaker diarization (pyannote, gated — needs HF_TOKEN).
        if spec.get("diarize", True):
            token = os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_TOKEN") or os.getenv("HF_API_TOKEN")
            try:
                dia = whisperx.DiarizationPipeline(use_auth_token=token, device=device)
                kw = {}
                if spec.get("min_speakers"):
                    kw["min_speakers"] = int(spec["min_speakers"])
                if spec.get("max_speakers"):
                    kw["max_speakers"] = int(spec["max_speakers"])
                dseg = dia(audio, **kw)
                res = whisperx.assign_word_speakers(dseg, res)
            except Exception as exc:  # noqa: BLE001
                out["warnings"].append(f"diarize failed: {exc}")

        segs = []
        for s in res.get("segments", []):
            segs.append({
                "start": s.get("start"),
                "end": s.get("end"),
                "text": (s.get("text") or "").strip(),
                "speaker": s.get("speaker"),
            })
        words = []
        for s in res.get("segments", []):
            for w in s.get("words", []) or []:
                words.append({
                    "word": w.get("word"),
                    "start": w.get("start"),
                    "end": w.get("end"),
                    "speaker": w.get("speaker"),
                })
        out.update({
            "ok": True,
            "language": lang,
            "text": " ".join(x["text"] for x in segs if x["text"]).strip(),
            "segments": segs,
            "words": words,
        })
    except Exception as exc:  # noqa: BLE001
        out["error"] = f"{type(exc).__name__}: {exc}"
        out["trace"] = traceback.format_exc()[-1500:]

    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2, default=str)
    print("STT_DONE ok=%s segs=%s warnings=%s" % (out.get("ok"), len(out.get("segments", [])), out.get("warnings")))


if __name__ == "__main__":
    run(sys.argv[1], sys.argv[2])
