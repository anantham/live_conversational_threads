import Foundation
import FluidAudio
import Swifter

// MARK: - Configuration

/// Directory holding the Parakeet v3 CoreML models. FluidAudio resolves the
/// model files via `<parentOf(directory)>/<repo.folderName>`, where the v3
/// repo folderName is `parakeet-tdt-0.6b-v3-coreml`. The real models on this
/// box live in `.../FluidAudio/Models/parakeet-tdt-0.6b-v3/`; a sibling
/// `parakeet-tdt-0.6b-v3-coreml/` of symlinks is created out-of-band so we can
/// hand FluidAudio the path it expects WITHOUT touching the originals.
let modelsParent = URL(fileURLWithPath: NSHomeDirectory())
    .appendingPathComponent("Library/Application Support/FluidAudio/Models")
let modelDir = modelsParent.appendingPathComponent("parakeet-tdt-0.6b-v3-coreml")

let port: UInt16 = 5096
let engineName = "fluidaudio-parakeet"
let modelName = "parakeet-tdt-0.6b-v3"

func log(_ msg: String) {
    let ts = ISO8601DateFormatter().string(from: Date())
    FileHandle.standardError.write("[\(ts)] \(msg)\n".data(using: .utf8)!)
}

// MARK: - JSON response shapes (match the mlx-whisper server exactly)

struct Segment {
    let id: Int
    let start: Double?
    let end: Double?
    let text: String
}

// MARK: - Segment building from FluidAudio token timings

let wordBoundary = "\u{2581}"  // ▁ SentencePiece word-start marker
let sentenceEnders: Set<Character> = [".", "!", "?", "…"]

/// Build sentence-level segments from per-token timings. Each token carries a
/// start/end time; `▁` prefixes a word start. We accumulate tokens into a
/// segment, decode them to text, and close the segment at sentence-ending
/// punctuation (falling back to a single trailing segment for the remainder).
func buildSegments(from timings: [TokenTiming]?, fullText: String) -> [Segment] {
    guard let timings = timings, !timings.isEmpty else {
        // No timing info: one segment with the whole text, null times.
        let t = fullText.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return [] }
        return [Segment(id: 0, start: nil, end: nil, text: t)]
    }

    var segments: [Segment] = []
    var curTokens: [String] = []
    var curStart: Double? = nil
    var curEnd: Double = 0
    var segId = 0

    func flush() {
        guard !curTokens.isEmpty else { return }
        let text = curTokens.joined()
            .replacingOccurrences(of: wordBoundary, with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty {
            segments.append(Segment(id: segId, start: curStart, end: curEnd, text: text))
            segId += 1
        }
        curTokens.removeAll(keepingCapacity: true)
        curStart = nil
    }

    for timing in timings {
        if curStart == nil { curStart = timing.startTime }
        curEnd = timing.endTime
        curTokens.append(timing.token)
        // Close the segment after sentence-ending punctuation.
        if let last = timing.token.last, sentenceEnders.contains(last) {
            flush()
        }
    }
    flush()  // trailing remainder

    // Defensive fallback: if grouping produced nothing usable, return whole text.
    if segments.isEmpty {
        let t = fullText.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return [] }
        return [Segment(id: 0, start: timings.first?.startTime, end: timings.last?.endTime, text: t)]
    }
    return segments
}

// MARK: - Warm, persistent ASR manager (loaded once at startup)

/// Holds the single warm AsrManager. The manager is a FluidAudio actor, so all
/// access is awaited. `transcribe` requires a fresh decoder state per call.
actor TranscriptionService {
    private let manager: AsrManager

    init(manager: AsrManager) {
        self.manager = manager
    }

    func transcribe(url: URL) async throws -> ASRResult {
        var state = try TdtDecoderState()
        return try await manager.transcribe(url, decoderState: &state)
    }
}

/// Published once the models finish loading; read by request handlers.
/// Handlers run on Swifter's GCD worker threads, so a lock guards the slot.
final class ServiceHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var _service: TranscriptionService?
    var service: TranscriptionService? {
        get { lock.lock(); defer { lock.unlock() }; return _service }
        set { lock.lock(); _service = newValue; lock.unlock() }
    }
}
let holder = ServiceHolder()

/// Thread-safe one-shot result holder for the sync/async bridge.
final class ResultBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Result<ASRResult, Error>?
    func set(_ v: Result<ASRResult, Error>) { lock.lock(); value = v; lock.unlock() }
    func get() -> Result<ASRResult, Error>? { lock.lock(); defer { lock.unlock() }; return value }
}

// MARK: - HTTP responses
//
// Swifter's `.raw` case reports body length -1, so it emits NO Content-Length
// and keeps the connection open with no end-of-body signal — clients then hang
// or read an empty body. We build a `.raw` but set Content-Length + Connection:
// close explicitly so the response is well-formed and the socket closes cleanly.
func jsonResponse(_ code: Int, _ reason: String, _ obj: Any) -> HttpResponse {
    let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
    return jsonResponse(code, reason, data: data)
}

func jsonResponse(_ code: Int, _ reason: String, data: Data) -> HttpResponse {
    let headers = [
        "Content-Type": "application/json",
        "Content-Length": "\(data.count)",
        "Connection": "close",
    ]
    return .raw(code, reason, headers) { try $0.write(data) }
}

// MARK: - HTTP server

let server = HttpServer()

server["/health"] = { _ in
    let ready = holder.service != nil
    let body: [String: String] = [
        "status": ready ? "healthy" : "loading",
        "engine": engineName,
        "model": modelName,
    ]
    return jsonResponse(ready ? 200 : 503, ready ? "OK" : "Service Unavailable", body)
}

server.POST["/v1/audio/transcriptions"] = { request in
    let reqStart = Date()

    guard let service = holder.service else {
        return jsonResponse(503, "Service Unavailable", ["error": "models still loading"])
    }

    let parts = request.parseMultiPartFormData()
    guard let filePart = parts.first(where: { $0.name == "file" }), !filePart.body.isEmpty else {
        log("transcribe: no 'file' multipart field (parts=\(parts.compactMap { $0.name }))")
        return jsonResponse(400, "Bad Request", ["error": "missing 'file' multipart field"])
    }

    // Persist the uploaded bytes to a temp WAV; AsrManager.transcribe(url:)
    // handles WAV decode + 16k/mono conversion + long-file streaming itself.
    let tmpURL = FileManager.default.temporaryDirectory
        .appendingPathComponent("fa-stt-\(UUID().uuidString).wav")
    defer { try? FileManager.default.removeItem(at: tmpURL) }

    do {
        try Data(filePart.body).write(to: tmpURL)
    } catch {
        log("transcribe: failed to write temp file: \(error)")
        return jsonResponse(500, "Internal Server Error", ["error": "failed to buffer upload"])
    }

    log("transcribe: \(filePart.fileName ?? "?") bytes=\(filePart.body.count)")

    // Bridge Swifter's synchronous handler (on a GCD worker thread) to the
    // async actor. Blocking this worker thread is fine; the Swift concurrency
    // pool stays free to run the transcription Task.
    let box = ResultBox()
    let sem = DispatchSemaphore(value: 0)
    Task {
        do {
            let result = try await service.transcribe(url: tmpURL)
            box.set(.success(result))
        } catch {
            box.set(.failure(error))
        }
        sem.signal()
    }
    sem.wait()

    switch box.get() {
    case .success(let asr):
        let elapsed = Date().timeIntervalSince(reqStart)
        let cleanText = asr.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let segments = buildSegments(from: asr.tokenTimings, fullText: cleanText)
        // Build the response dict explicitly so the null-valued keys
        // (language/speakers/diarization/etc.) are PRESENT in the JSON — a
        // Swift JSONEncoder would silently drop nil Optionals, breaking the
        // drop-in shape the whisper server callers expect.
        let segmentDicts: [[String: Any]] = segments.map { s in
            [
                "id": s.id,
                "start": s.start.map { $0 as Any } ?? NSNull(),
                "end": s.end.map { $0 as Any } ?? NSNull(),
                "text": s.text,
            ]
        }
        let body: [String: Any] = [
            "text": cleanText,
            "segments": segmentDicts,
            "language": NSNull(),
            "speakers": NSNull(),
            "speaker_embeddings": NSNull(),
            "diarization": NSNull(),
            "embeddings": NSNull(),
            "_engine": engineName,
            "_model": modelName,
            "_elapsed_seconds": elapsed,
        ]
        log("transcribe: ok chars=\(cleanText.count) segs=\(segments.count) elapsed=\(String(format: "%.2f", elapsed))s")
        return jsonResponse(200, "OK", body)
    case .failure(let error):
        log("transcribe: ASR failed: \(error)")
        return jsonResponse(500, "Internal Server Error", ["error": "transcription failed: \(error.localizedDescription)"])
    case .none:
        return jsonResponse(500, "Internal Server Error", ["error": "internal: no result"])
    }
}

// MARK: - Startup

// Never reach out to HuggingFace; fail loudly if a model file is missing.
DownloadUtils.enforceOffline = true

// Start the HTTP server immediately so /health is reachable while models load.
do {
    try server.start(port, forceIPv4: true)
    log("fluidaudio-stt listening on http://localhost:\(port)  (engine=\(engineName) model=\(modelName))")
} catch {
    log("FATAL: failed to bind port \(port): \(error)")
    exit(1)
}

// Load models on the concurrency pool, then publish the warm service.
// The top-level stays synchronous (no `await`), so `dispatchMain()` below can
// park the real main thread to service GCD/Swifter without starving the
// concurrency executor that runs this Task.
log("Loading Parakeet v3 models from \(modelDir.path) ...")
Task {
    let t0 = Date()
    do {
        let models = try await AsrModels.load(from: modelDir, version: .v3)
        let manager = AsrManager(config: .default, models: models)
        guard await manager.isAvailable else {
            log("FATAL: AsrManager reports not available after load")
            exit(1)
        }
        holder.service = TranscriptionService(manager: manager)
        log("Models loaded and warm in \(String(format: "%.2f", Date().timeIntervalSince(t0)))s — ready")
    } catch {
        log("FATAL: model load failed: \(error)")
        exit(1)
    }
}

// Park the main thread to run GCD work forever. Never returns.
dispatchMain()
