// An avatar attachment that carries more than one frame, decoded into the
// uniform-tick form UIKit can play.
//
// `UIImage(data:)` keeps only the first frame, so an animated GIF or WebP
// avatar renders as a still on the phone while the desktop — which draws the
// same URL into an `<img>` — plays it. The server already accepts these:
// `botAvatarUrlSchema` allows png, jpg, gif and webp.
//
// The decode lives here rather than in the view because ImageIO is available
// on macOS too, so `swift test` covers the timing rules below without Xcode,
// a simulator, or signing.
import CoreGraphics
import Foundation
import ImageIO

public struct AnimatedImage {
    /// Frames in play order, already expanded so that every entry is shown
    /// for the same tick. UIKit plays `UIImage.animatedImage(with:duration:)`
    /// at a uniform rate, so a frame held twice as long as its neighbour is
    /// represented as two entries rather than one longer one.
    public let frames: [CGImage]

    /// Length of one loop, in seconds.
    public let duration: TimeInterval

    /// The tick each entry in `frames` occupies.
    public var tick: TimeInterval { frames.isEmpty ? 0 : duration / Double(frames.count) }
}

public enum AnimatedImageDecoder {
    /// What a container reports when it says nothing, matching the delay
    /// browsers assume for a frame with no timing of its own.
    static let defaultDelay: TimeInterval = 0.1

    /// GIFs in the wild encode "as fast as possible" as 0 or 10ms. Every
    /// browser silently rewrites anything under this to `defaultDelay`;
    /// honouring the literal value instead would spin an avatar at 100fps.
    static let minimumHonouredDelay: TimeInterval = 0.011

    /// A hostile or merely enormous attachment must not be expanded into an
    /// unbounded frame array held in memory for the life of a roster row.
    static let sourceFrameLimit = 240
    static let expandedFrameLimit = 600

    /// Avatars render at no more than 112 points in the app. Decode every
    /// animation frame into a bounded thumbnail so a small compressed file
    /// cannot expand into hundreds of full-resolution pixel buffers.
    static let maximumFramePixelSize = 256

    /// Per-container timing keys, newest container first. A frame carries an
    /// unclamped delay (the author's real intent) and a clamped one (already
    /// floored by the encoder); prefer the former and fall back to the latter.
    private static let timingKeys: [(container: CFString, unclamped: CFString, clamped: CFString)] = [
        (kCGImagePropertyGIFDictionary, kCGImagePropertyGIFUnclampedDelayTime, kCGImagePropertyGIFDelayTime),
        (kCGImagePropertyPNGDictionary, kCGImagePropertyAPNGUnclampedDelayTime, kCGImagePropertyAPNGDelayTime),
        (kCGImagePropertyWebPDictionary, kCGImagePropertyWebPUnclampedDelayTime, kCGImagePropertyWebPDelayTime),
        (kCGImagePropertyHEICSDictionary, kCGImagePropertyHEICSUnclampedDelayTime, kCGImagePropertyHEICSDelayTime),
    ]

    /// Decode `data` as an animation, or return nil when it is a still — a
    /// single-frame image, an undecodable payload, or one whose frames cannot
    /// be read. Nil is the caller's signal to fall back to `UIImage(data:)`,
    /// which is what every static avatar keeps doing.
    public static func decode(_ data: Data) -> AnimatedImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let available = CGImageSourceGetCount(source)
        guard available > 1 else { return nil }

        let count = min(available, sourceFrameLimit)
        var frames: [CGImage] = []
        var delays: [TimeInterval] = []
        frames.reserveCapacity(count)
        delays.reserveCapacity(count)

        // ImageIO applies EXIF orientation while producing the thumbnail, so
        // UIKit receives consistently upright frames without a second full-
        // resolution allocation.
        let thumbnailOptions: CFDictionary = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maximumFramePixelSize,
            kCGImageSourceShouldCacheImmediately: true,
        ] as CFDictionary

        for index in 0..<count {
            guard let frame = CGImageSourceCreateThumbnailAtIndex(
                source, index, thumbnailOptions
            ) else { continue }
            frames.append(frame)
            delays.append(delay(at: index, in: source))
        }

        // One decodable frame is a still, however many the container claimed.
        guard frames.count > 1 else { return nil }
        return expand(frames: frames, delays: delays)
    }

    /// Flatten variable per-frame delays onto one tick by repeating the frames
    /// that are held longer. The tick is the shortest delay present, so the
    /// fastest frame stays a single entry.
    ///
    /// Each delay is rounded to the nearest whole tick, so a loop whose delays
    /// are not multiples of each other drifts slightly: 1.0s beside 0.6s is
    /// held for two ticks, 1.2s. Exact timing would need the delays' common
    /// divisor as the tick, which for arbitrary authored values expands into
    /// far more entries for a difference no one watching an avatar can see.
    private static func expand(frames: [CGImage], delays: [TimeInterval]) -> AnimatedImage? {
        let tick = max(delays.min() ?? defaultDelay, minimumHonouredDelay)
        var expanded: [CGImage] = []
        expanded.reserveCapacity(frames.count)

        for (frame, delay) in zip(frames, delays) {
            let repeats = max(1, Int((delay / tick).rounded()))
            for _ in 0..<repeats {
                expanded.append(frame)
                // Truncating keeps the loop short rather than dropping it; the
                // duration below is derived from the count, so what plays stays
                // in time with itself.
                if expanded.count >= expandedFrameLimit { break }
            }
            if expanded.count >= expandedFrameLimit { break }
        }

        guard expanded.count > 1 else { return nil }
        return AnimatedImage(frames: expanded, duration: tick * Double(expanded.count))
    }

    /// The delay for one frame, in seconds, across every animated container
    /// ImageIO reads.
    private static func delay(at index: Int, in source: CGImageSource) -> TimeInterval {
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any] else {
            return defaultDelay
        }

        for keys in timingKeys {
            guard let container = properties[keys.container] as? [CFString: Any] else { continue }
            for key in [keys.unclamped, keys.clamped] {
                guard let value = container[key] as? Double else { continue }
                // A zero or near-zero delay is "as fast as possible", which is
                // the one value that must not be taken literally.
                if value >= minimumHonouredDelay { return value }
            }
            return defaultDelay
        }

        return defaultDelay
    }
}
