import SwiftUI
import UIKit
import CompanionCore

/// An agent identity image fetched from the paired computer with the device
/// bearer token. The mascot is deterministic fallback for missing, stale, or
/// undecodable attachments, so identity never becomes an empty placeholder.
struct BotAvatarView: View {
    let bot: Bot
    let size: CGFloat
    var state: MausState = .idle
    /// Opt-in, mirroring MausAvatar: an animated face is a 30fps canvas.
    var animated = false
    var comets = false

    @Environment(\.sessionActions) private var sessionActions
    private var session: Session { sessionActions! }
    @State private var image: UIImage?
    @State private var failed = false

    private var crop: AvatarCrop { bot.avatarCrop ?? .mascot }
    /// Which of the two renderings this bot gets. The decision itself is a
    /// pure function in `CompanionCore` so it can be tested without a
    /// rendered `Canvas`; see `resolveBotAvatarOutcome`.
    private var outcome: BotAvatarOutcome {
        resolveBotAvatarOutcome(
            crop: crop, hasUrl: bot.avatarUrl != nil, imageDecoded: image != nil, failed: failed)
    }

    var body: some View {
        Group {
            switch outcome {
            // The picture instead of the mascot, masked to the chosen shape.
            case .flatImage: flatImage
            // The mascot in the bot's own colours, which is also the fallback
            // whenever there is no usable picture so identity is never an
            // empty placeholder.
            case .gradientMascot: mascot
            }
        }
        .frame(width: size, height: size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(bot.name) avatar")
        .task(id: "\(bot.avatarUrl ?? "")|\(crop.rawValue)") {
            image = nil
            failed = false
            // Only the flat crops paint the bytes; the mascot never needs them.
            guard crop != .mascot, bot.avatarUrl != nil else { return }
            let data = await session.avatarData(for: bot)
            guard !Task.isCancelled else { return }
            guard let data, let decoded = Self.decode(data) else {
                failed = true
                return
            }
            guard !Task.isCancelled else { return }
            image = decoded
        }
    }

    /// SwiftUI's `Image` draws only a `UIImage`'s static representation, so a
    /// multi-frame attachment has to go through the UIKit view that plays
    /// `images` itself. Stills keep the original path.
    @ViewBuilder
    private func attachment(_ image: UIImage) -> some View {
        if image.images == nil {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
        } else {
            AnimatedAttachmentView(image: image)
        }
    }

    /// An animated GIF or WebP becomes an animated `UIImage`; everything else
    /// — and anything whose frames will not decode — stays a still.
    private static func decode(_ data: Data) -> UIImage? {
        if let animation = AnimatedImageDecoder.decode(data) {
            let frames = animation.frames.map { UIImage(cgImage: $0) }
            if let animated = UIImage.animatedImage(with: frames, duration: animation.duration) {
                return animated
            }
        }
        return UIImage(data: data)
    }

    /// Only reached with a decoded image: `resolveBotAvatarOutcome` returns
    /// `.flatImage` solely when one exists.
    @ViewBuilder private var flatImage: some View {
        if let image {
            attachment(image)
                .frame(width: size, height: size)
                .clipShape(mask)
        }
    }

    private var mascot: some View {
        MausAvatar(
            color: bot.color, size: size, bodyId: bot.mascotBody,
            state: state, eyeStyle: MascotEyeStyle(stored: bot.mascotEyes),
            completedTurnID: session.mascotCompletionIDs[bot.threadId],
            animated: animated, comets: comets)
    }

    private var mask: AnyShape {
        switch crop {
        case .circle: AnyShape(Circle())
        case .rounded: AnyShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
        case .square, .mascot: AnyShape(Rectangle())
        }
    }
}

/// `UIImageView` plays an animated `UIImage` on its own; SwiftUI has no
/// equivalent. Sizing is left entirely to the SwiftUI frame around it, so the
/// view never fights the layout with an intrinsic size taken from the file.
private struct AnimatedAttachmentView: UIViewRepresentable {
    let image: UIImage

    func makeUIView(context: Context) -> UIImageView {
        let view = UIImageView(image: image)
        view.contentMode = .scaleAspectFill
        view.clipsToBounds = true
        view.isAccessibilityElement = false
        for axis in [NSLayoutConstraint.Axis.horizontal, .vertical] {
            view.setContentHuggingPriority(.defaultLow, for: axis)
            view.setContentCompressionResistancePriority(.defaultLow, for: axis)
        }
        view.startAnimating()
        return view
    }

    func updateUIView(_ view: UIImageView, context: Context) {
        guard view.image !== image else { return }
        view.image = image
        view.startAnimating()
    }
}

struct ChatAvatarView: View {
    let chat: Chat
    let size: CGFloat
    var state: MausState = .idle
    /// Opt-in, mirroring MausAvatar: an animated face is a 30fps canvas.
    var animated = false
    var comets = false

    var body: some View {
        switch chat {
        case let .bot(bot):
            BotAvatarView(bot: bot, size: size, state: state, animated: animated, comets: comets)
        case let .room(room):
            ChannelAvatarView(room: room, size: size)
        }
    }
}

/// Uses the same authenticated, connection-scoped attachment cache as bot faces.
/// A room with no photo wears its members' faces, like `GroupMark` on the desktop.
struct ChannelAvatarView: View {
    let room: Room
    let size: CGFloat
    @Environment(\.sessionActions) private var sessionActions
    private var session: Session { sessionActions! }
    @State private var image: UIImage?
    var body: some View {
        Group {
            if room.avatarUrl == nil, !faces.isEmpty {
                GroupMarkView(members: faces, size: size)
            } else {
                Group {
                    if let image { Image(uiImage: image).resizable().scaledToFill() }
                    else { Image(systemName: "person.3.fill").resizable().scaledToFit().padding(size * 0.22).foregroundStyle(Color.accentColor) }
                }
                .frame(width: size, height: size).background(Color.accentColor.opacity(0.12)).clipShape(Circle())
            }
        }
        .accessibilityLabel("\(room.name) group avatar")
        .task(id: room.avatarUrl) {
            image = nil
            guard let path = room.avatarUrl, let data = await session.avatarData(path: path), !Task.isCancelled else { return }
            image = UIImage(data: data)
        }
    }

    /// The room's people (everyone but me first), then its bots.
    private var faces: [SharedContact] {
        let me = session.roomActorId ?? room.ownerPersonId
        let people = (room.people ?? []).sorted { ($0.id == me ? 1 : 0) < ($1.id == me ? 1 : 0) }
            .map { SharedContact(id: $0.id, name: $0.name, kind: "person", homeId: $0.homeId, color: $0.color, avatar: $0.avatar) }
        let bots = room.members(from: session.state.bots).map { bot in
            SharedContact(id: bot.id, name: bot.name, kind: "bot", color: bot.color, mascotEyes: bot.mascotEyes,
                          mascotBody: bot.mascotBody, avatarUrl: bot.avatarUrl, avatarCrop: bot.avatarCrop)
        }
        return people + bots
    }
}

// Lives beside the bot faces rather than in MausAvatar.swift: that file is
// also compiled into the widget, which has no session to fetch photos with.
/// A group's face: up to three members overlapping, bare like the mascots.
/// Mirrors `GroupMark` in `src/components/Avatar.tsx`.
struct GroupMarkView: View {
    let members: [SharedContact]
    let size: CGFloat

    private struct Slot { let x: CGFloat; let y: CGFloat; let s: CGFloat }

    var body: some View {
        let shown = Array(members.prefix(3))
        let slots: [Slot] = shown.count == 2
            ? [Slot(x: 0, y: 0.06, s: 0.66), Slot(x: 0.36, y: 0.32, s: 0.64)]
            : [Slot(x: 0.24, y: 0, s: 0.52), Slot(x: 0, y: 0.44, s: 0.54), Slot(x: 0.46, y: 0.44, s: 0.54)]
        ZStack(alignment: .topLeading) {
            if shown.count <= 1 {
                if let only = shown.first { face(only, size) }
                else { Image(systemName: "person.2.fill").font(.system(size: size * 0.4)).frame(width: size, height: size) }
            } else {
                ForEach(Array(shown.enumerated()), id: \.element.id) { index, member in
                    face(member, (slots[index].s * size).rounded())
                        .offset(x: slots[index].x * size, y: slots[index].y * size)
                        .zIndex(Double(index))
                }
            }
        }
        .frame(width: size, height: size, alignment: .topLeading)
    }

    @ViewBuilder private func face(_ member: SharedContact, _ px: CGFloat) -> some View {
        if member.kind == "bot" {
            // a bot with a photo wears it here too, matching its face everywhere else
            SharedBotFace(bot: member, size: px)
        } else {
            PersonFaceView(name: member.name, avatar: member.avatar, size: px)
        }
    }

    /// Everyone but me first, so the mark shows who else is here.
    static func faces(_ room: SharedRoomSummary, contacts: [SharedContact], selfID: String?) -> [SharedContact] {
        let order = room.memberIds.filter { $0 != selfID } + (selfID.map { [$0] } ?? [])
        return order.compactMap { id in contacts.first { $0.id == id } }
    }
}

/// A shared contact that is a bot: its stored photo in its chosen crop, or
/// the mascot while the photo loads, when there is none, or when it fails,
/// so a dead attachment never leaves an empty circle. Same decision as
/// `BotAvatarView`, for the contact shape shared rooms carry.
struct SharedBotFace: View {
    let bot: SharedContact
    let size: CGFloat
    var state: MausState = .idle
    /// Opt-in, mirroring MausAvatar: an animated face is a 30fps canvas.
    var animated = false
    @Environment(\.sessionActions) private var sessionActions
    @State private var image: UIImage?
    @State private var failed = false

    private var crop: AvatarCrop { bot.avatarCrop ?? .mascot }

    var body: some View {
        Group {
            switch resolveBotAvatarOutcome(crop: crop, hasUrl: bot.avatarUrl != nil, imageDecoded: image != nil, failed: failed) {
            case .flatImage:
                if let image {
                    Image(uiImage: image).resizable().scaledToFill()
                        .frame(width: size, height: size).clipShape(mask)
                }
            case .gradientMascot:
                MausAvatar(color: bot.color ?? "green", size: size, bodyId: bot.mascotBody, state: state,
                    eyeStyle: MascotEyeStyle(stored: bot.mascotEyes), animated: animated)
            }
        }
        .frame(width: size, height: size)
        .task(id: "\(bot.avatarUrl ?? "")|\(crop.rawValue)") {
            image = nil
            failed = false
            guard crop != .mascot, let path = bot.avatarUrl else { return }
            let data = await sessionActions?.avatarData(path: path)
            guard !Task.isCancelled else { return }
            guard let data, let decoded = UIImage(data: data) else { failed = true; return }
            image = decoded
        }
    }

    private var mask: AnyShape {
        switch crop {
        case .circle: AnyShape(Circle())
        case .rounded: AnyShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
        case .square, .mascot: AnyShape(Rectangle())
        }
    }
}

/// A person's face: their photo cut out like a mascot, or their initial.
/// The photo is either an inline data URL or an app path such as
/// `/api/multiplayer/people/<id>/photo`, fetched with the paired token.
struct PersonFaceView: View {
    let name: String
    let avatar: String?
    let size: CGFloat
    @Environment(\.sessionActions) private var sessionActions
    @State private var fetched: UIImage?

    var body: some View {
        Group {
            if let avatar, avatar.hasPrefix("data:"), PersonCutout.image(dataURL: avatar) != nil {
                PersonPhotoView(dataURL: avatar, size: size)
            } else if let fetched {
                if PersonCutout.isCut(fetched) {
                    Image(uiImage: fetched).resizable().scaledToFit().frame(width: size, height: size)
                } else {
                    Image(uiImage: fetched).resizable().scaledToFill().frame(width: size, height: size).clipShape(Circle())
                }
            } else {
                ProfileAvatar(name: name, size: size)
            }
        }
        .task(id: avatar) {
            fetched = nil
            guard let avatar, avatar.hasPrefix("/api/"),
                  let data = await sessionActions?.avatarData(path: avatar), !Task.isCancelled else { return }
            fetched = PersonCutout.image(data: data, key: avatar)
        }
    }
}
