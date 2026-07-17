// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "maman-observer",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "maman-observer", targets: ["MamanObserver"]),
        .library(name: "ObserverCore", targets: ["ObserverCore"]),
    ],
    targets: [
        // Pure logic: protocol encoding, redaction, event building. NO AppKit,
        // NO networking — fully testable on any Mac.
        .target(name: "ObserverCore"),
        // The executable wires AX/NSWorkspace notifications into ObserverCore.
        // It links AppKit and ApplicationServices ONLY — never Network,
        // URLSession, or any socket API (CI greps for this).
        .executableTarget(
            name: "MamanObserver",
            dependencies: ["ObserverCore"]
        ),
        // Assertion runner for machines with Command Line Tools only (no
        // XCTest). CI runs the XCTest suite; both cover the same cases.
        .executableTarget(
            name: "ObserverCoreTestRunner",
            dependencies: ["ObserverCore"]
        ),
        .testTarget(name: "ObserverCoreTests", dependencies: ["ObserverCore"]),
    ]
)
