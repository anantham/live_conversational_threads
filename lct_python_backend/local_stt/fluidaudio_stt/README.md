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

## Browser access (CORS)

The app's browser page calls this server directly through Tailscale Serve
(`https://<host>.ts.net:5443` → `127.0.0.1:5096`), which is a cross-origin
request. The server therefore:

- answers every `OPTIONS` preflight with `204`. When the request's `Origin`
  is allowed, the reply carries the allow-origin, methods (`GET, POST,
  OPTIONS`) and headers (`Authorization, Content-Type`) headers; when it is
  not, the reply carries none of them and the browser refuses the call;
- adds `Access-Control-Allow-Origin` to `/health` and transcription replies,
  errors included, when the request carries an allowed `Origin`.

Only `Authorization` and `Content-Type` are allowed as request headers. A
client that adds another custom header will fail its preflight.

`LOCAL_STT_CORS_ORIGINS` (same variable as `../server.py`) sets who may read
replies: `*` (default) for any origin, or a comma-separated allowlist such as
`https://threads.adityaarpitha.com,http://127.0.0.1:4173`. Entries are exact
origins (scheme, host, optional port); a list that includes `*` allows any
origin, and an empty value allows none. It is not access control: a page can
still send a plain multipart POST that the server runs.

With `*`, any website open in a browser on the tailnet can call this server
and read the reply. The server keeps no transcripts, so a reply only ever
describes the audio that same page sent, but the page can use the M5's
compute. Set the allowlist in the LaunchAgent to restrict which browser
origins can read replies. Preventing unwanted use of the M5 requires access
control before transcription begins.

Health responses use `Cache-Control: no-store` so an origin or a model-loading
state on an earlier request cannot determine what a later health check sees.
Check `/health` with and without an allowed Origin and confirm both responses
carry this header.

`FLUIDAUDIO_STT_PORT` overrides port 5096, to run a second copy beside the live
service. Check a build with:

```sh
curl -si -X OPTIONS http://localhost:5096/v1/audio/transcriptions \
  -H 'Origin: https://threads.adityaarpitha.com' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization'   # 204 + Access-Control-Allow-*
curl -si http://localhost:5096/health -H 'Origin: https://threads.adityaarpitha.com'
```

There is no Swift test target (the server is one `main.swift` executable), so
this curl check is the written exception to the regression-test rule.

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
