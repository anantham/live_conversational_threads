import Foundation
import FluidAudio
import Swifter
import AVFoundation

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
        if let last = timing.token.last, sentenceEnders.contains(last) {
            flush()
        }
    }
    flush()

    if segments.isEmpty {
        let t = fullText.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return [] }
        return [Segment(id: 0, start: timings.first?.startTime, end: timings.last?.endTime, text: t)]
    }
    return segments
}

// MARK: - Speaker assignment (diarization × ASR alignment)

/// Assign a speaker to each ASR segment by finding the diarization speaker
/// segment with the maximum overlap in time.
func assignSpeaker(to segment: Segment, from diarSegments: [TimedSpeakerSegment]) -> String? {
    guard let segStart = segment.start, let segEnd = segment.end, segStart < segEnd else { return nil }
    var bestSpeaker: String? = nil
    var bestOverlap: Double = 0
    for d in diarSegments {
        let dStart = Double(d.startTimeSeconds)
        let dEnd = Double(d.endTimeSeconds)
        let overlapStart = max(segStart, dStart)
        let overlapEnd = min(segEnd, dEnd)
        let overlap = max(0, overlapEnd - overlapStart)
        if overlap > bestOverlap {
            bestOverlap = overlap
            bestSpeaker = d.speakerId
        }
    }
    return bestSpeaker
}

/// Build the segments array for the response. When diarization results are
/// present, each segment gets a `speaker` field (e.g. "S1", "S2").
func buildSegmentDicts(_ segments: [Segment], diarResult: DiarizationResult?) -> [[String: Any]] {
    let diarSegs = diarResult?.segments ?? []
    return segments.map { s in
        var dict: [String: Any] = [
            "id": s.id,
            "start": s.start.map { $0 as Any } ?? NSNull(),
            "end":   s.end.map   { $0 as Any } ?? NSNull(),
            "text":  s.text,
        ]
        if let speaker = assignSpeaker(to: s, from: diarSegs) {
            dict["speaker"] = speaker
        }
        return dict
    }
}

// MARK: - Audio sample extraction (for diarization)

/// Decode an audio file to 16 kHz mono Float32 samples using AVFoundation.
/// Returns nil if the file cannot be decoded or converted.
func extractAudioSamples(from url: URL) -> [Float]? {
    guard let srcFile = try? AVAudioFile(forReading: url) else { return nil }
    let srcFmt = srcFile.processingFormat
    let targetFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                   sampleRate: 16000, channels: 1, interleaved: false)!
    guard let converter = AVAudioConverter(from: srcFmt, to: targetFmt) else { return nil }

    // Estimate output frame count, add 5% buffer for rounding.
    let outFrames = AVAudioFrameCount(Double(srcFile.length) * 16000.0 / srcFmt.sampleRate * 1.05 + 1)
    guard let outBuf = AVAudioPCMBuffer(pcmFormat: targetFmt, frameCapacity: outFrames) else { return nil }

    var reachedEnd = false
    let inputBlock: AVAudioConverterInputBlock = { _, outStatus in
        let frameCount = AVAudioFrameCount(srcFmt.sampleRate)
        guard let inBuf = AVAudioPCMBuffer(pcmFormat: srcFmt, frameCapacity: frameCount) else {
            outStatus.pointee = .endOfStream; return nil
        }
        do {
            try srcFile.read(into: inBuf)
            if inBuf.frameLength == 0 { outStatus.pointee = .endOfStream; return nil }
            outStatus.pointee = .haveData
            return inBuf
        } catch {
            outStatus.pointee = .endOfStream; reachedEnd = true; return nil
        }
    }

    var convErr: NSError?
    converter.convert(to: outBuf, error: &convErr, withInputFrom: inputBlock)
    guard convErr == nil, let ch = outBuf.floatChannelData?[0] else { return nil }
    return Array(UnsafeBufferPointer(start: ch, count: Int(outBuf.frameLength)))
}

// MARK: - ASR service (warm, persistent)

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

// MARK: - Diarizer service (warm, persistent)

actor DiarizerService {
    private let manager: DiarizerManager

    init(manager: DiarizerManager) {
        self.manager = manager
    }

    /// Run diarization on pre-decoded 16 kHz mono Float samples.
    func diarize(samples: [Float]) throws -> DiarizationResult {
        try manager.performCompleteDiarization(samples, sampleRate: 16000)
    }
}

// MARK: - Service holders

final class ServiceHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var _service: TranscriptionService?
    var service: TranscriptionService? {
        get { lock.lock(); defer { lock.unlock() }; return _service }
        set { lock.lock(); _service = newValue; lock.unlock() }
    }
}

final class DiarizerHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var _service: DiarizerService?
    var service: DiarizerService? {
        get { lock.lock(); defer { lock.unlock() }; return _service }
        set { lock.lock(); _service = newValue; lock.unlock() }
    }
}

let holder = ServiceHolder()
let diarizerHolder = DiarizerHolder()

// MARK: - Sync/async bridge helper

final class ResultBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Result<T, Error>?
    func set(_ v: Result<T, Error>) { lock.lock(); value = v; lock.unlock() }
    func get() -> Result<T, Error>? { lock.lock(); defer { lock.unlock() }; return value }
}

// MARK: - HTTP responses

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
    let hasDiarizer = diarizerHolder.service != nil
    let body: [String: Any] = [
        "status": ready ? "healthy" : "loading",
        "engine": engineName,
        "model": modelName,
        "diarization": hasDiarizer ? "ready" : "unavailable",
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

    // Check if diarization was requested.
    let diarizeRequested = parts.first(where: { $0.name == "diarize" })?.body
        .flatMap { String(bytes: $0, encoding: .utf8) }
        .map { $0.lowercased() == "true" } ?? false

    // Persist the uploaded bytes to a temp WAV.
    let tmpURL = FileManager.default.temporaryDirectory
        .appendingPathComponent("fa-stt-\(UUID().uuidString).wav")
    defer { try? FileManager.default.removeItem(at: tmpURL) }

    do {
        try Data(filePart.body).write(to: tmpURL)
    } catch {
        log("transcribe: failed to write temp file: \(error)")
        return jsonResponse(500, "Internal Server Error", ["error": "failed to buffer upload"])
    }

    log("transcribe: \(filePart.fileName ?? "?") bytes=\(filePart.body.count) diarize=\(diarizeRequested)")

    // Run ASR and (optionally) diarization concurrently.
    let asrBox = ResultBox<ASRResult>()
    let diarBox = ResultBox<DiarizationResult?>()
    let sem = DispatchSemaphore(value: 0)
    let sem2 = DispatchSemaphore(value: 0)

    Task {
        do {
            let result = try await service.transcribe(url: tmpURL)
            asrBox.set(.success(result))
        } catch {
            asrBox.set(.failure(error))
        }
        sem.signal()
    }

    if diarizeRequested, let diarService = diarizerHolder.service {
        Task {
            if let samples = extractAudioSamples(from: tmpURL) {
                do {
                    let result = try await diarService.diarize(samples: samples)
                    diarBox.set(.success(result))
                } catch {
                    log("transcribe: diarization failed: \(error) — continuing without speakers")
                    diarBox.set(.success(nil))
                }
            } else {
                log("transcribe: could not decode audio for diarization — continuing without speakers")
                diarBox.set(.success(nil))
            }
            sem2.signal()
        }
    } else {
        if diarizeRequested {
            log("transcribe: diarization requested but diarizer not loaded")
        }
        diarBox.set(.success(nil))
        sem2.signal()
    }

    sem.wait()
    sem2.wait()

    switch asrBox.get() {
    case .success(let asr):
        let elapsed = Date().timeIntervalSince(reqStart)
        let cleanText = asr.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let segments = buildSegments(from: asr.tokenTimings, fullText: cleanText)

        var diarResult: DiarizationResult? = nil
        if case .success(let d) = diarBox.get() { diarResult = d }

        let segmentDicts = buildSegmentDicts(segments, diarResult: diarResult)

        // Build the speaker list (unique speaker IDs from diarization).
        let speakersValue: Any
        if let diar = diarResult, !diar.segments.isEmpty {
            let uniqueIds = Array(Set(diar.segments.map { $0.speakerId })).sorted()
            speakersValue = uniqueIds as Any
        } else {
            speakersValue = NSNull()
        }

        let body: [String: Any] = [
            "text": cleanText,
            "segments": segmentDicts,
            "language": NSNull(),
            "speakers": speakersValue,
            "speaker_embeddings": NSNull(),
            "diarization": NSNull(),
            "embeddings": NSNull(),
            "_engine": engineName,
            "_model": modelName,
            "_elapsed_seconds": elapsed,
            "_diarized": diarResult != nil,
        ]
        log("transcribe: ok chars=\(cleanText.count) segs=\(segments.count) elapsed=\(String(format: "%.2f", elapsed))s speakers=\(diarResult?.segments.count ?? 0)")
        return jsonResponse(200, "OK", body)
    case .failure(let error):
        log("transcribe: ASR failed: \(error)")
        return jsonResponse(500, "Internal Server Error", ["error": "transcription failed: \(error.localizedDescription)"])
    case .none:
        return jsonResponse(500, "Internal Server Error", ["error": "internal: no result"])
    }
}

// MARK: - Startup

// Start the HTTP server immediately so /health is reachable while models load.
do {
    try server.start(port, forceIPv4: true)
    log("fluidaudio-stt listening on http://localhost:\(port)  (engine=\(engineName) model=\(modelName))")
} catch {
    log("FATAL: failed to bind port \(port): \(error)")
    exit(1)
}

// Step 1: Load diarizer models (downloads from HuggingFace on first run,
// uses local cache thereafter). Block main thread here so enforceOffline is
// set only AFTER the download attempt — a Task{} without this semaphore races
// with the enforceOffline assignment and always sees enforceOffline=true.
let diarSem = DispatchSemaphore(value: 0)
Task {
    let t0 = Date()
    do {
        let models = try await DiarizerModels.download()
        let manager = DiarizerManager()
        manager.initialize(models: models)
        diarizerHolder.service = DiarizerService(manager: manager)
        log("Diarizer ready in \(String(format: "%.2f", Date().timeIntervalSince(t0)))s (pyannote + wespeaker)")
    } catch {
        log("Diarizer not available: \(error) — transcription will work without speaker labels")
    }
    diarSem.signal()
}
diarSem.wait()

// Step 2: Prevent ASR from auto-downloading missing model files.
// Set AFTER diarizer so pyannote/wespeaker models can reach HuggingFace.
DownloadUtils.enforceOffline = true

// Step 3: Load ASR models on the concurrency pool, then publish the warm service.
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
        log("ASR models loaded and warm in \(String(format: "%.2f", Date().timeIntervalSince(t0)))s — ready")
    } catch {
        log("FATAL: ASR model load failed: \(error)")
        exit(1)
    }
}

// Park the main thread to run GCD work forever. Never returns.
dispatchMain()
