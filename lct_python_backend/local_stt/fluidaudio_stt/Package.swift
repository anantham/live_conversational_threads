// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "fluidaudio-stt",
    platforms: [
        .macOS(.v14)
    ],
    dependencies: [
        // FluidAudio Parakeet ASR SDK (verified repo + tag from the upstream Package.swift).
        .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.15.4"),
        // Lightweight embeddable HTTP server with multipart/form-data parsing.
        .package(url: "https://github.com/httpswift/swifter.git", from: "1.5.0"),
    ],
    targets: [
        .executableTarget(
            name: "fluidaudio-stt",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio"),
                .product(name: "Swifter", package: "swifter"),
            ],
            path: "Sources/fluidaudio-stt",
            // Swift 5 language mode: avoids the Swift-6 default `@MainActor`
            // isolation of top-level globals in `main.swift`. Under Swift 6 mode,
            // Swifter's GCD-thread handler closures touching those globals trip
            // `swift_task_isCurrentExecutor` -> `dispatch_assert_queue` (SIGTRAP).
            // We still build against the Swift-6 toolchain; only the language
            // mode for THIS target is pinned to 5.
            swiftSettings: [
                .swiftLanguageMode(.v5)
            ]
        )
    ]
)
