// How a bot's avatar resolves: which of the two renderings it gets.
//
// Pure logic with no view in it, which is the point: `swift test` builds
// `Sources/CompanionCore` and nothing else, so a decision left inside
// `BotAvatarView`'s `body` is a decision no test can reach. The desktop split
// the same decision out for the same reason — `resolveBotAvatarOutcome` in
// `src/components/Avatar.tsx`, tested in `src/components/Avatar.test.ts`.
import Foundation

/// The two ways a bot's identity can be drawn.
///
/// Mirrors the desktop's `BotAvatarOutcome` union, name for name, so the two
/// renderers can be compared by reading them side by side.
public enum BotAvatarOutcome: String, CaseIterable, Hashable, Sendable {
    /// The uploaded picture itself, masked to a circle/rounded/square, shown
    /// exactly as it is. No mascot: the image replaces it.
    case flatImage
    /// The mascot in the bot's own colour gradient. Also the fallback for
    /// everything that cannot be drawn.
    case gradientMascot
}

/// Pick how to draw a bot's avatar from the profile plus what has actually
/// been confirmed to load.
///
/// The fallback is the spec's, not a convenience: a missing, stale or
/// undecodable attachment lands on `.gradientMascot`, so identity is never an
/// empty placeholder or a half-drawn body. On the phone the confirmation is
/// the decode itself — `imageDecoded` is true only once `UIImage(data:)`
/// returned something — where the desktop leans on the `<img>` element's own
/// `onError` instead.
///
/// `failed` is a fetch or decode that already came back empty; `imageDecoded
/// == false` on its own also covers "still in flight". Both draw the gradient
/// mascot, and deliberately so: an avatar that is still loading shows the
/// bot's colours rather than a hole.
public func resolveBotAvatarOutcome(
    crop: AvatarCrop,
    hasUrl: Bool,
    imageDecoded: Bool,
    failed: Bool
) -> BotAvatarOutcome {
    // No attachment at all, or the bot asked for the plain mascot.
    guard hasUrl, crop != .mascot else { return .gradientMascot }
    // Nothing to draw with yet — in flight, or gone.
    guard imageDecoded, !failed else { return .gradientMascot }
    return .flatImage
}

extension AvatarCrop {
    /// The crop to persist once a *generated* avatar comes back.
    ///
    /// A generated image keeps whatever crop the server chose (`serverCrop`,
    /// from `server/index.ts` — `circle` for a mascot bot). A `nil`
    /// `serverCrop` is unreachable in practice — the server always assigns a
    /// crop — so the fallback matches the desktop's
    /// (`result.bot.avatarCrop ?? "circle"` in
    /// `src/components/BotProfileAvatarCard.tsx`): `.circle`, what the server
    /// actually assigns a mascot bot, not the `.mascot` "no picture" state
    /// that would throw away the picture just generated.
    ///
    /// The one thing that overrides the server is the user themselves: if
    /// they move the crop picker while generation was still in flight,
    /// `latestCrop` differs from `cropAtStart` and that newer explicit choice
    /// wins outright, server pick or not.
    public static func afterGenerating(
        cropAtStart: AvatarCrop,
        latestCrop: AvatarCrop,
        serverCrop: AvatarCrop?
    ) -> AvatarCrop {
        latestCrop != cropAtStart ? latestCrop : (serverCrop ?? .circle)
    }
}
