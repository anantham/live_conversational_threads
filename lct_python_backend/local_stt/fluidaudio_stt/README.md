# fluidaudio-stt

Standalone Swift HTTP transcription service. Drop-in replacement for the local
mlx-whisper STT server, but backed by **FluidAudio's Parakeet TDT 0.6b v3** ASR
(which does not hallucinate-loop on short/silent chunks the way whisper does).

- Port: **5096** (the whisper server on **5095** is untouched — fully isolated).
- Engine: `fluidaudio-parakeet`, model `parakeet-tdt-0.6b-v3`.
- Models loaded **once at startup** (warm, persistent); never per request.
- Network egress disabled at runtime (`DownloadUtils.enforceOffline = true`):
  if a model file is missing it fails loudly rather than hitting HuggingFace.

## Endpoints

- `GET /health`
  → `{"status":"healthy","engine":"fluidaudio-parakeet","model":"parakeet-tdt-0.6b-v3"}`
  (returns `status:"loading"` + HTTP 503 until models finish loading).
- `POST /v1/audio/transcriptions` — `multipart/form-data` with a `file` field
  (WAV; 16 kHz mono PCM s16le is ideal, but any AVFoundation-decodable audio is
  converted internally). Other fields (`diarize`, `response_format`, `language`,
  `word_timestamps`, …) are accepted and ignored. Returns the whisper-server JSON
  shape exactly:

  ```json
  {"text": "...",
   "segments": [{"id": 0, "start": 0.08, "end": 1.2, "text": "..."}],
   "language": null,
   "speakers": null, "speaker_embeddings": null, "diarization": null, "embeddings": null,
   "_engine": "fluidaudio-parakeet", "_model": "parakeet-tdt-0.6b-v3", "_elapsed_seconds": 5.85}
  ```

  Segments carry **real** start/end timestamps derived from FluidAudio's per-token
  timings (grouped into sentences at sentence-ending punctuation). If timings are
  ever absent, a single segment with the whole text and null start/end is returned.

## Build

```sh
swift build -c release
```

## Run

```sh
# Foreground:
.build/release/fluidaudio-stt

# Background (survives the launching shell):
nohup .build/release/fluidaudio-stt > /tmp/fa-stt.log 2>&1 < /dev/null &
echo $! > /tmp/fa-stt.pid; disown
```

Wait for the log line `Models loaded and warm in N.NNs — ready`, then:

```sh
curl -s http://localhost:5096/health
curl -s -F "file=@/path/to.wav" http://localhost:5096/v1/audio/transcriptions
```

## Stop

```sh
kill "$(cat /tmp/fa-stt.pid)"        # or: pkill -f '.build/release/fluidaudio-stt'
```

## Model path note

FluidAudio resolves v3 models at `<parent>/parakeet-tdt-0.6b-v3-coreml/`. The real
models on this box live in `.../FluidAudio/Models/parakeet-tdt-0.6b-v3/` (no
`-coreml` suffix). A sibling directory `parakeet-tdt-0.6b-v3-coreml/` of **symlinks**
to those files was created so FluidAudio finds them without the originals being
touched or duplicated:

```sh
MODELS="$HOME/Library/Application Support/FluidAudio/Models"
mkdir -p "$MODELS/parakeet-tdt-0.6b-v3-coreml"
for f in Encoder.mlmodelc Decoder.mlmodelc Preprocessor.mlmodelc JointDecisionv3.mlmodelc \
         parakeet_vocab.json parakeet_v3_vocab.json config.json; do
  ln -s "$MODELS/parakeet-tdt-0.6b-v3/$f" "$MODELS/parakeet-tdt-0.6b-v3-coreml/$f"
done
```
