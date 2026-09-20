import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import CompanionCore

/// The fixtures are synthesised here rather than checked in: a GIF small
/// enough to commit is also small enough to build, and building it is the
/// only way to assert against delays chosen by the test.
final class AnimatedImageTests: XCTestCase {
    func testStillImageDecodesAsNilSoTheViewFallsBackToUIImage() {
        let still = gif(delays: [0.1])
        XCTAssertNil(AnimatedImageDecoder.decode(still))
    }

    func testGarbageDecodesAsNilRatherThanThrowing() {
        XCTAssertNil(AnimatedImageDecoder.decode(Data("not an image".utf8)))
        XCTAssertNil(AnimatedImageDecoder.decode(Data()))
    }

    func testEqualDelaysProduceOneEntryPerFrame() throws {
        let decoded = try XCTUnwrap(AnimatedImageDecoder.decode(gif(delays: [0.1, 0.1, 0.1])))

        XCTAssertEqual(decoded.frames.count, 3)
        XCTAssertEqual(decoded.duration, 0.3, accuracy: 0.001)
        XCTAssertEqual(decoded.tick, 0.1, accuracy: 0.001)
    }

    func testLongerFramesAreHeldByRepeatingThemOnTheShortestTick() throws {
        // 0.2s beside 0.1s: the slow frame occupies two ticks, so the loop is
        // three entries of 0.1s rather than two entries averaged to 0.15s.
        let decoded = try XCTUnwrap(AnimatedImageDecoder.decode(gif(delays: [0.2, 0.1])))

        XCTAssertEqual(decoded.frames.count, 3)
        XCTAssertEqual(decoded.tick, 0.1, accuracy: 0.001)
        XCTAssertEqual(decoded.duration, 0.3, accuracy: 0.001)
    }

    func testZeroDelayIsTreatedAsTheBrowserDefaultInsteadOfSpinning() throws {
        // A 0s frame beside a 0.1s frame must not make the tick 0s; every
        // browser rewrites "as fast as possible" to 0.1s.
        let decoded = try XCTUnwrap(AnimatedImageDecoder.decode(gif(delays: [0, 0.1])))

        XCTAssertEqual(decoded.tick, 0.1, accuracy: 0.001)
        XCTAssertEqual(decoded.frames.count, 2)
    }

    func testExpansionIsBoundedForAWildlyLopsidedLoop() throws {
        // 60s against a 0.01s tick would expand to 6000 entries unbounded.
        let decoded = try XCTUnwrap(AnimatedImageDecoder.decode(gif(delays: [0.02, 60])))

        XCTAssertLessThanOrEqual(decoded.frames.count, AnimatedImageDecoder.expandedFrameLimit)
        XCTAssertEqual(decoded.duration, decoded.tick * Double(decoded.frames.count), accuracy: 0.001)
    }

    func testDurationAlwaysMatchesTheFrameCountTimesTheTick() throws {
        let decoded = try XCTUnwrap(AnimatedImageDecoder.decode(gif(delays: [0.1, 0.3, 0.2])))

        XCTAssertEqual(decoded.duration, decoded.tick * Double(decoded.frames.count), accuracy: 0.001)
    }

    func testFramesAreDecodedWithinTheAvatarPixelBudget() throws {
        let decoded = try XCTUnwrap(AnimatedImageDecoder.decode(
            gif(delays: [0.1, 0.1], width: 1_024, height: 512)
        ))

        for frame in decoded.frames {
            XCTAssertLessThanOrEqual(frame.width, AnimatedImageDecoder.maximumFramePixelSize)
            XCTAssertLessThanOrEqual(frame.height, AnimatedImageDecoder.maximumFramePixelSize)
        }
        XCTAssertEqual(decoded.frames.first?.width, AnimatedImageDecoder.maximumFramePixelSize)
        XCTAssertEqual(decoded.frames.first?.height, AnimatedImageDecoder.maximumFramePixelSize / 2)
    }

    func testFrameOrientationIsNormalizedWhileDownsampling() throws {
        let decoded = try XCTUnwrap(AnimatedImageDecoder.decode(
            gif(delays: [0.1, 0.1], width: 4, height: 2, orientation: 6)
        ))

        XCTAssertEqual(decoded.frames.first?.width, 2)
        XCTAssertEqual(decoded.frames.first?.height, 4)
    }

    // MARK: - fixture

    /// One synthetic GIF per delay, each a different shade so frames are distinct.
    private func gif(
        delays: [TimeInterval],
        width: Int = 2,
        height: Int = 2,
        orientation: Int? = nil
    ) -> Data {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data, UTType.gif.identifier as CFString, delays.count, nil
        ) else {
            XCTFail("could not create a GIF destination")
            return Data()
        }

        CGImageDestinationSetProperties(destination, [
            kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0],
        ] as CFDictionary)

        for (index, delay) in delays.enumerated() {
            guard let frame = swatch(
                level: UInt8(truncatingIfNeeded: index * 60),
                width: width,
                height: height
            ) else {
                XCTFail("could not build a frame")
                return Data()
            }
            var properties: [CFString: Any] = [
                kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFUnclampedDelayTime: delay],
            ]
            if let orientation { properties[kCGImagePropertyOrientation] = orientation }
            CGImageDestinationAddImage(destination, frame, properties as CFDictionary)
        }

        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return data as Data
    }

    private func swatch(level: UInt8, width: Int, height: Int) -> CGImage? {
        var pixels = [UInt8](repeating: level, count: width * height * 4)
        for index in stride(from: 3, to: pixels.count, by: 4) { pixels[index] = 255 }

        return pixels.withUnsafeMutableBytes { raw -> CGImage? in
            guard let context = CGContext(
                data: raw.baseAddress,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: width * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return nil }
            return context.makeImage()
        }
    }
}
