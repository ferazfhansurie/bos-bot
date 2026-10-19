// Media in the conversation, shaped the way ChatGPT shapes it.
//
// What you send sits above your bubble as 80pt thumbnails and file chips.
// What a bot sends reads as part of its reply: a single image at its own
// aspect, several in a row, video as a poster with a play button, audio as
// a chip that plays in place, and documents as file tiles. A tap on any
// image opens the black full-screen viewer, which pages through every image
// in the message.
//
// Every byte still comes through the message-scoped, authenticated file
// route (`Session.fetchAttachment` / `prepareAttachmentPreview`); a path is
// never opened on the phone.
import AVFoundation
import AVKit
import CompanionCore
import LinkPresentation
import SwiftUI
import UIKit
import UniformTypeIdentifiers

// MARK: - Entry point

/// Everything a message carries besides its text, in ChatGPT's order:
/// images first, then video, audio and files.
struct MessageMedia: View {
    let attachments: [DisplayedMessageAttachment]
    let threadId: String
    let messageId: String
    /// Your own message: thumbnails and chips sit on the trailing side.
    var mine = false

    private var images: [DisplayedMessageAttachment] { attachments.filter { $0.kind == .image } }
    private var files: [DisplayedMessageAttachment] { attachments.filter { $0.kind == .file } }

    var body: some View {
        VStack(alignment: mine ? .trailing : .leading, spacing: 8) {
            if !images.isEmpty {
                if mine {
                    UserImageThumbs(images: images, threadId: threadId, messageId: messageId)
                } else {
                    AssistantImageGallery(images: images, threadId: threadId, messageId: messageId)
                }
            }
            ForEach(files, id: \.path) { file in
                switch MediaFileKind(name: file.name) {
                case .video:
                    VideoAttachmentView(attachment: file, threadId: threadId, messageId: messageId)
                case .audio:
                    AudioAttachmentView(attachment: file, threadId: threadId, messageId: messageId, compact: mine)
                default:
                    FileChipView(attachment: file, threadId: threadId, messageId: messageId, compact: mine)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
    }
}

/// What kind of thing a file is, from its name: the icon, the colour of
/// its tile and the word under its title.
enum MediaFileKind: Equatable {
    case video, audio, pdf, document, spreadsheet, presentation, code, archive, text, other

    init(name: String) {
        let ext = (name as NSString).pathExtension.lowercased()
        let type = UTType(filenameExtension: ext)
        if type?.conforms(to: .movie) == true || ["mp4", "mov", "m4v", "webm"].contains(ext) { self = .video }
        else if type?.conforms(to: .audio) == true || ["mp3", "m4a", "wav", "aac", "ogg", "opus"].contains(ext) { self = .audio }
        else if ext == "pdf" { self = .pdf }
        else if ["doc", "docx", "pages", "rtf", "odt"].contains(ext) { self = .document }
        else if ["xls", "xlsx", "csv", "numbers", "tsv", "ods"].contains(ext) { self = .spreadsheet }
        else if ["ppt", "pptx", "key", "odp"].contains(ext) { self = .presentation }
        else if ["zip", "gz", "tar", "rar", "7z"].contains(ext) { self = .archive }
        else if ["md", "txt", "log"].contains(ext) { self = .text }
        else if type?.conforms(to: .sourceCode) == true || ["swift", "ts", "tsx", "js", "py", "json", "html", "css", "sh", "go", "rs", "sql", "yml", "yaml"].contains(ext) { self = .code }
        else { self = .other }
    }

    var symbol: String {
        switch self {
        case .video: "play.rectangle.fill"
        case .audio: "waveform"
        case .pdf: "doc.text.fill"
        case .document: "doc.text"
        case .spreadsheet: "tablecells"
        case .presentation: "rectangle.on.rectangle.angled"
        case .code: "chevron.left.forwardslash.chevron.right"
        case .archive: "doc.zipper"
        case .text: "doc.plaintext"
        case .other: "doc"
        }
    }

    var label: String {
        switch self {
        case .video: "Video"
        case .audio: "Audio"
        case .pdf: "PDF"
        case .document: "Document"
        case .spreadsheet: "Spreadsheet"
        case .presentation: "Presentation"
        case .code: "Code"
        case .archive: "Archive"
        case .text: "Text"
        case .other: "File"
        }
    }

    /// ChatGPT's coloured file tiles: pink PDFs, blue documents, green
    /// sheets, orange slides.
    var tile: Color {
        switch self {
        case .pdf: Color(red: 1, green: 0.333, blue: 0.533)
        case .document, .text: Color(red: 0.008, green: 0.522, blue: 1)
        case .spreadsheet: Color(red: 0.063, green: 0.639, blue: 0.498)
        case .presentation: Color(red: 1, green: 0.549, blue: 0.161)
        case .video: Color(red: 0.6, green: 0.35, blue: 1)
        case .audio: Color(red: 0.95, green: 0.33, blue: 0.2)
        case .code, .archive, .other: Color(white: 0.45)
        }
    }
}

// MARK: - Loading

enum AttachmentImagePhase {
    case loading
    case loaded(UIImage)
    case failed
}

/// One image through the authenticated route, decoded off the main thread
/// at the size it is drawn, and only once it is near the screen: the
/// transcript is an eager stack, so a long chat would otherwise download
/// every picture it ever held on open.
struct RemoteAttachmentImage<Content: View>: View {
    let attachment: DisplayedMessageAttachment
    let threadId: String
    let messageId: String
    var maximumPixelSize = 1_200
    @ViewBuilder let content: (AttachmentImagePhase, _ retry: @escaping () -> Void) -> Content

    @Environment(\.sessionActions) private var sessionActions
    @State private var phase: AttachmentImagePhase = .loading
    @State private var visible = false
    @State private var attempt = 0

    private var key: String { "\(messageId)\u{1F}\(attachment.path)\u{1F}\(attempt)\u{1F}\(visible)" }

    var body: some View {
        content(phase) { phase = .loading; attempt += 1 }
            .nearScreen($visible)
            .task(id: key) {
                guard visible, case .loading = phase, let session = sessionActions else { return }
                do {
                    let download = try await session.fetchAttachment(
                        threadId: threadId, messageId: messageId, path: attachment.path, cacheResult: true
                    )
                    try Task.checkCancellation()
                    guard download.data.count <= AttachmentPolicy.maximumImageBytes else { phase = .failed; return }
                    let data = download.data, size = maximumPixelSize
                    let decoded = await Task.detached(priority: .userInitiated) {
                        decodeAttachmentThumbnail(data, maximumPixelSize: size)
                    }.value
                    try Task.checkCancellation()
                    if let image = decoded.value { phase = .loaded(UIImage(cgImage: image)) } else { phase = .failed }
                } catch is CancellationError {
                    return
                } catch {
                    if !Task.isCancelled { phase = .failed }
                }
            }
    }
}

extension View {
    /// True while the view is within a screen's height of the viewport.
    func nearScreen(_ visible: Binding<Bool>) -> some View {
        background {
            GeometryReader { proxy in
                let frame = proxy.frame(in: .global)
                Color.clear
                    .onAppear { updateNearScreen(frame, visible) }
                    .onChange(of: frame) { _, next in updateNearScreen(next, visible) }
            }
        }
    }
}

@MainActor
private func updateNearScreen(_ frame: CGRect, _ visible: Binding<Bool>) {
    let bounds = UIApplication.shared.connectedScenes
        .compactMap { $0 as? UIWindowScene }
        .flatMap(\.windows)
        .first(where: \.isKeyWindow)?.bounds ?? UIScreen.main.bounds
    let near = frame.intersects(bounds.insetBy(dx: 0, dy: -bounds.height * 0.5))
    if visible.wrappedValue != near { visible.wrappedValue = near }
}

/// A file downloaded for playing or previewing, removed from disk when the
/// last view holding it goes.
final class PreparedAttachment {
    let item: FilePreviewItem
    init(_ item: FilePreviewItem) { self.item = item }
    deinit { item.cleanUp() }
}

@MainActor
func prepareAttachmentFile(
    _ session: Session?, threadId: String, messageId: String, path: String
) async throws -> PreparedAttachment {
    guard let session else { throw URLError(.notConnectedToInternet) }
    let downloaded = try await session.prepareAttachmentPreview(threadId: threadId, messageId: messageId, path: path)
    guard let item = FilePreviewItem(downloaded: downloaded) else { throw URLError(.cannotDecodeContentData) }
    return PreparedAttachment(item)
}

// MARK: - Placeholder

/// The grey box an image sits in while it loads: a slow .68 ↔ .82 pulse.
struct MediaPlaceholder: View {
    var cornerRadius: CGFloat = 16
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    var body: some View {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .fill(GPT.placeholder)
            .opacity(reduceMotion ? 0.76 : (dim ? 0.68 : 0.82))
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) { dim = true }
            }
            .accessibilityLabel("Loading image")
    }
}

/// "Image unavailable", in the space the image would have taken.
private struct ImageUnavailable: View {
    var cornerRadius: CGFloat = 16
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "photo").font(.system(size: 22)).foregroundStyle(GPT.tertiaryText)
            Text("Couldn't load this image").font(.system(size: 14)).foregroundStyle(GPT.secondaryText)
            Button("Try again", action: retry)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Color.primary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(GPT.card, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous).strokeBorder(GPT.subtleBorder))
    }
}

/// .18s ease-out from 98% scale, the way a finished image arrives.
private struct ImageEnter: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false

    func body(content: Content) -> some View {
        content
            .scaleEffect(shown || reduceMotion ? 1 : 0.98)
            .opacity(shown || reduceMotion ? 1 : 0)
            .onAppear { withAnimation(.easeOut(duration: 0.18)) { shown = true } }
    }
}

// MARK: - Your images

/// 80pt square thumbnails above your bubble, trailing, 8pt apart.
struct UserImageThumbs: View {
    let images: [DisplayedMessageAttachment]
    let threadId: String
    let messageId: String
    @State private var viewing: LightboxStart?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(images.enumerated()), id: \.element.path) { index, image in
                    RemoteAttachmentImage(attachment: image, threadId: threadId, messageId: messageId, maximumPixelSize: 320) { phase, retry in
                        switch phase {
                        case .loading:
                            RoundedRectangle(cornerRadius: 12.5, style: .continuous)
                                .fill(GPT.softFill)
                                .overlay(ProgressView().controlSize(.small))
                                .overlay(RoundedRectangle(cornerRadius: 12.5, style: .continuous).strokeBorder(GPT.strongBorder))
                                .frame(width: 80, height: 80)
                        case let .loaded(uiImage):
                            Button { viewing = LightboxStart(index: index) } label: {
                                Image(uiImage: uiImage)
                                    .resizable().scaledToFill()
                                    .frame(width: 78, height: 78)
                                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                                    .padding(1)
                                    .overlay(RoundedRectangle(cornerRadius: 12.5, style: .continuous).strokeBorder(GPT.strongBorder))
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Image: \(image.name)")
                        case .failed:
                            Button(action: retry) {
                                Text("Failed")
                                    .font(.system(size: 10))
                                    .foregroundStyle(Color.red)
                                    .padding(.horizontal, 4)
                                    .frame(width: 64, height: 64)
                                    .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 12.5, style: .continuous))
                                    .overlay(RoundedRectangle(cornerRadius: 12.5, style: .continuous).strokeBorder(Color.red.opacity(0.2)))
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Image failed to load. Tap to retry")
                        }
                    }
                }
            }
            .environment(\.layoutDirection, .leftToRight)
        }
        .defaultScrollAnchor(.trailing)
        .fixedSize(horizontal: images.count <= 3, vertical: false)
        .fullScreenCover(item: $viewing) { start in
            MediaLightbox(images: images, start: start.index, threadId: threadId, messageId: messageId)
        }
    }
}

struct LightboxStart: Identifiable {
    let index: Int
    var id: Int { index }
}

// MARK: - A bot's images

/// One image at its own aspect (400pt wide at most when portrait, 480
/// otherwise); several in a row that keeps their aspects when they fit,
/// and turns into square tiles that page sideways when they do not.
struct AssistantImageGallery: View {
    let images: [DisplayedMessageAttachment]
    let threadId: String
    let messageId: String
    @State private var viewing: LightboxStart?
    @State private var aspects: [String: CGFloat] = [:]

    var body: some View {
        Group {
            if images.count == 1 {
                single(images[0])
            } else {
                GeometryReader { proxy in row(width: proxy.size.width) }
                    .frame(height: rowHeight)
            }
        }
        .fullScreenCover(item: $viewing) { start in
            MediaLightbox(images: images, start: start.index, threadId: threadId, messageId: messageId)
        }
#if DEBUG
        // `-open-lightbox <message id>`: a fixture screenshot of the viewer.
        .task {
            let args = ProcessInfo.processInfo.arguments
            guard let i = args.firstIndex(of: "-open-lightbox"), i + 1 < args.count, args[i + 1] == messageId else { return }
            try? await Task.sleep(for: .seconds(3))
            viewing = LightboxStart(index: 0)
        }
#endif
    }

    // The row is two slots wide on a phone; ChatGPT's desktop row is four.
    private let slots: CGFloat = 2
    private let gap: CGFloat = 8
    @State private var rowWidth: CGFloat = 358
    private var rowHeight: CGFloat { ((rowWidth - gap * (slots - 1)) / slots).rounded(.down) }

    private func single(_ image: DisplayedMessageAttachment) -> some View {
        let aspect = aspects[image.path] ?? 1
        let maxWidth: CGFloat = aspect < 1 ? 400 : (aspect < 2 ? 480 : .infinity)
        return tile(image, index: 0)
            .aspectRatio(aspect, contentMode: .fit)
            .frame(maxWidth: maxWidth, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func row(width: CGFloat) -> some View {
        let height = ((width - gap * (slots - 1)) / slots).rounded(.down)
        let natural = images.reduce(CGFloat(0)) { $0 + height * (aspects[$1.path] ?? 1) } + gap * CGFloat(images.count - 1)
        let fits = natural <= width + 0.5
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: gap) {
                ForEach(Array(images.enumerated()), id: \.element.path) { index, image in
                    tile(image, index: index)
                        .frame(width: fits ? height * (aspects[image.path] ?? 1) : height, height: height)
                }
            }
            .scrollTargetLayout()
        }
        .scrollTargetBehavior(.viewAligned)
        .scrollDisabled(fits)
        .overlay(alignment: .bottomTrailing) {
            if !fits {
                HStack(spacing: 2) {
                    Image(systemName: "photo.on.rectangle").font(.system(size: 11, weight: .semibold))
                    Text("\(images.count)")
                }
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(.white)
                .padding(.leading, 6).padding(.trailing, 8)
                .frame(height: 24)
                .background(Color.black.opacity(0.45), in: Capsule())
                .padding(8)
                .allowsHitTesting(false)
            }
        }
        .onAppear { if rowWidth != width { rowWidth = width } }
        .onChange(of: width) { _, next in rowWidth = next }
    }

    private func tile(_ image: DisplayedMessageAttachment, index: Int) -> some View {
        RemoteAttachmentImage(attachment: image, threadId: threadId, messageId: messageId) { phase, retry in
            switch phase {
            case .loading:
                MediaPlaceholder()
            case let .loaded(uiImage):
                Button { viewing = LightboxStart(index: index) } label: {
                    Color.clear
                        .overlay(Image(uiImage: uiImage).resizable().scaledToFill())
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .overlay(alignment: .bottom) {
                            LinearGradient(colors: [.clear, .black.opacity(0.3)], startPoint: .top, endPoint: .bottom)
                                .frame(height: 80)
                                .clipShape(UnevenRoundedRectangle(bottomLeadingRadius: 16, bottomTrailingRadius: 16, style: .continuous))
                                .opacity(0)
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .modifier(ImageEnter())
                .accessibilityLabel("Image \(index + 1): \(image.name)")
                .onAppear {
                    let aspect = uiImage.size.width / max(1, uiImage.size.height)
                    if aspects[image.path] != aspect { aspects[image.path] = aspect }
                }
            case .failed:
                ImageUnavailable(retry: retry)
            }
        }
    }
}

// MARK: - Full-screen viewer

/// Black, image centred and fitted, "2 of 4" in a blurred bar, swipe to
/// page, pinch or double-tap to zoom, drag down to close.
struct MediaLightbox: View {
    let images: [DisplayedMessageAttachment]
    let start: Int
    let threadId: String
    let messageId: String
    @Environment(\.dismiss) private var dismiss
    @State private var index = 0
    @State private var drag: CGFloat = 0
    @State private var loaded: [String: UIImage] = [:]

    var body: some View {
        ZStack {
            Color.black.opacity(1 - min(0.6, abs(drag) / 600)).ignoresSafeArea()
            TabView(selection: $index) {
                ForEach(Array(images.enumerated()), id: \.element.path) { offset, image in
                    LightboxPage(image: image, threadId: threadId, messageId: messageId) { loaded[image.path] = $0 }
                        .tag(offset)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .offset(y: drag)
            .simultaneousGesture(
                DragGesture(minimumDistance: 20)
                    .onChanged { value in
                        if abs(value.translation.height) > abs(value.translation.width) { drag = max(0, value.translation.height) }
                    }
                    .onEnded { value in
                        if value.translation.height > 140 { dismiss() } else { withAnimation(.snappy) { drag = 0 } }
                    }
            )
        }
        .overlay(alignment: .top) {
            HStack {
                lightboxButton("xmark", label: "Close") { dismiss() }
                Spacer()
                if images.count > 1 {
                    Text("\(index + 1) of \(images.count)")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 12).frame(height: 36)
                        .background(.ultraThinMaterial, in: Capsule())
                        .environment(\.colorScheme, .dark)
                }
                Spacer()
                if let image = loaded[images[index].path] {
                    ShareLink(item: Image(uiImage: image), preview: SharePreview(images[index].name, image: Image(uiImage: image))) {
                        lightboxIcon("square.and.arrow.up")
                    }
                    .accessibilityLabel("Share")
                } else {
                    Color.clear.frame(width: 40, height: 40)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .opacity(drag > 0 ? 0 : 1)
        }
        .statusBarHidden()
        .onAppear { index = min(max(0, start), images.count - 1) }
        .accessibilityIdentifier("media-lightbox")
    }

    private func lightboxButton(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { lightboxIcon(symbol) }
            .buttonStyle(.plain)
            .accessibilityLabel(label)
    }

    private func lightboxIcon(_ symbol: String) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 40, height: 40)
            .background(.ultraThinMaterial, in: Circle())
            .environment(\.colorScheme, .dark)
    }
}

private struct LightboxPage: View {
    let image: DisplayedMessageAttachment
    let threadId: String
    let messageId: String
    let onLoad: (UIImage) -> Void
    @State private var scale: CGFloat = 1
    @State private var settled: CGFloat = 1

    var body: some View {
        RemoteAttachmentImage(attachment: image, threadId: threadId, messageId: messageId, maximumPixelSize: 2_400) { phase, retry in
            switch phase {
            case .loading:
                ProgressView().tint(.white)
            case let .loaded(uiImage):
                Image(uiImage: uiImage)
                    .resizable()
                    .scaledToFit()
                    .scaleEffect(scale)
                    .gesture(
                        MagnifyGesture()
                            .onChanged { scale = max(1, settled * $0.magnification) }
                            .onEnded { _ in settled = scale }
                    )
                    .onTapGesture(count: 2) {
                        withAnimation(.snappy) { scale = scale > 1 ? 1 : 2.5; settled = scale }
                    }
                    .onAppear { onLoad(uiImage) }
                    .accessibilityLabel(image.name)
            case .failed:
                VStack(spacing: 12) {
                    Text("Couldn't load this image").foregroundStyle(.white.opacity(0.8))
                    Button("Try again", action: retry).foregroundStyle(.white).fontWeight(.medium)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Video

/// The first frame with a play button; tapping plays it full screen in a
/// 9:16 player on black.
struct VideoAttachmentView: View {
    let attachment: DisplayedMessageAttachment
    let threadId: String
    let messageId: String
    @Environment(\.sessionActions) private var sessionActions
    @State private var prepared: PreparedAttachment?
    @State private var poster: UIImage?
    @State private var duration: Double?
    @State private var failed = false
    @State private var visible = false
    @State private var attempt = 0
    @State private var playing: PlayingVideo?

    private var aspect: CGFloat {
        guard let poster else { return 16 / 9 }
        return poster.size.width / max(1, poster.size.height)
    }

    var body: some View {
        Button {
            if let url = prepared?.item.url { playing = PlayingVideo(url: url) } else if failed { failed = false; attempt += 1 }
        } label: {
            ZStack {
                if let poster {
                    Color.clear.overlay(Image(uiImage: poster).resizable().scaledToFill())
                } else if failed {
                    GPT.card
                } else {
                    MediaPlaceholder()
                }
                if failed {
                    VStack(spacing: 6) {
                        Image(systemName: "exclamationmark.triangle").font(.system(size: 18))
                        Text("Couldn't load this video · Retry").font(.system(size: 13))
                    }
                    .foregroundStyle(GPT.secondaryText)
                } else {
                    Image(systemName: "play.fill")
                        .font(.system(size: 22, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 56, height: 56)
                        .background(Color.black.opacity(0.45), in: Circle())
                        .opacity(prepared == nil ? 0.5 : 1)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if let duration {
                    Text(Self.clock(duration))
                        .font(.system(size: 13, weight: .medium).monospacedDigit())
                        .foregroundStyle(.white)
                        .padding(.horizontal, 8).frame(height: 24)
                        .background(Color.black.opacity(0.45), in: Capsule())
                        .padding(8)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(GPT.subtleBorder))
        }
        .buttonStyle(.plain)
        .aspectRatio(aspect, contentMode: .fit)
        .frame(maxWidth: aspect < 1 ? 240 : 400, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityLabel("Video: \(attachment.name)")
        .accessibilityValue(prepared != nil ? "Loaded" : failed ? "Failed" : "Loading")
        .accessibilityHint("Plays the video")
        .nearScreen($visible)
        .task(id: "\(visible)\u{1F}\(attempt)") {
            guard visible, prepared == nil, !failed else { return }
            do {
                let file = try await prepareAttachmentFile(sessionActions, threadId: threadId, messageId: messageId, path: attachment.path)
                let asset = AVURLAsset(url: file.item.url)
                let generator = AVAssetImageGenerator(asset: asset)
                generator.appliesPreferredTrackTransform = true
                generator.maximumSize = CGSize(width: 900, height: 900)
                let frame = try? await generator.image(at: CMTime(seconds: 0.1, preferredTimescale: 600)).image
                let length = try? await asset.load(.duration)
                prepared = file
                poster = frame.map { UIImage(cgImage: $0) }
                duration = length.map(\.seconds).flatMap { $0.isFinite ? $0 : nil }
            } catch is CancellationError {
                return
            } catch {
                if !Task.isCancelled { failed = true }
            }
        }
        .fullScreenCover(item: $playing) { video in VideoLightbox(url: video.url) }
    }

    static func clock(_ seconds: Double) -> String {
        let s = max(0, Int(seconds.rounded()))
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}

struct PlayingVideo: Identifiable {
    let url: URL
    var id: String { url.path }
}

private struct VideoLightbox: View {
    let url: URL
    @Environment(\.dismiss) private var dismiss
    @State private var player: AVPlayer?

    var body: some View {
        GeometryReader { proxy in
            let width = min(proxy.size.width, proxy.size.height * 0.5625)
            ZStack {
                Color.black.ignoresSafeArea()
                if let player {
                    VideoPlayer(player: player)
                        .frame(width: width, height: width / 0.5625)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .accessibilityLabel("Video player")
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .overlay(alignment: .topLeading) {
            Button { dismiss() } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 40, height: 40)
                    .background(.ultraThinMaterial, in: Circle())
                    .environment(\.colorScheme, .dark)
            }
            .accessibilityLabel("Close video player")
            .padding(.horizontal, 16).padding(.top, 8)
        }
        .onAppear {
            let next = AVPlayer(url: url)
            player = next
            next.play()
        }
        .onDisappear { player?.pause() }
    }
}

// MARK: - Audio

/// A chip that plays in place: play/pause in the tile, the name, and the
/// time as it plays.
struct AudioAttachmentView: View {
    let attachment: DisplayedMessageAttachment
    let threadId: String
    let messageId: String
    var compact = false
    @Environment(\.sessionActions) private var sessionActions
    @State private var prepared: PreparedAttachment?
    @State private var player: AVPlayer?
    @State private var loading = false
    @State private var failed = false
    @State private var playing = false
    @State private var position: Double = 0
    @State private var duration: Double = 0
    @State private var loadTask: Task<Void, Never>?
    private let tick = Timer.publish(every: 0.25, on: .main, in: .common).autoconnect()

    var body: some View {
        HStack(spacing: 10) {
            Button(action: toggle) {
                ZStack {
                    RoundedRectangle(cornerRadius: 12.5, style: .continuous).fill(MediaFileKind.audio.tile)
                    if loading {
                        ProgressView().tint(.white).controlSize(.small)
                    } else {
                        Image(systemName: playing ? "pause.fill" : "play.fill")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(.white)
                            .contentTransition(.symbolEffect(.replace))
                    }
                }
                .frame(width: 40, height: 40)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(playing ? "Pause \(attachment.name)" : "Play \(attachment.name)")

            VStack(alignment: .leading, spacing: 4) {
                Text(attachment.name)
                    .font(.system(size: 15, weight: .medium))
                    .lineLimit(1).truncationMode(.middle)
                if failed {
                    Text("Couldn't load this file · Retry").font(.system(size: 13)).foregroundStyle(Color.red)
                } else if duration > 0 {
                    HStack(spacing: 8) {
                        GeometryReader { proxy in
                            Capsule().fill(GPT.strongBorder)
                                .overlay(alignment: .leading) {
                                    Capsule().fill(Color.primary.opacity(0.7))
                                        .frame(width: proxy.size.width * min(1, position / max(0.01, duration)))
                                }
                        }
                        .frame(height: 3)
                        Text("\(VideoAttachmentView.clock(position)) / \(VideoAttachmentView.clock(duration))")
                            .font(.system(size: 12).monospacedDigit())
                            .foregroundStyle(GPT.secondaryText)
                            .fixedSize()
                    }
                } else {
                    Text("Audio").font(.system(size: 13)).foregroundStyle(GPT.secondaryText)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(6)
        .padding(.trailing, 6)
        .frame(width: compact ? 240 : 300)
        .background(GPT.softFill, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(GPT.subtleBorder))
        .onReceive(tick) { _ in
            guard let player, playing else { return }
            position = player.currentTime().seconds.isFinite ? player.currentTime().seconds : 0
            if duration > 0, position >= duration - 0.05 { playing = false; player.seek(to: .zero); position = 0 }
        }
        .onDisappear {
            loadTask?.cancel()
            loadTask = nil
            loading = false
            player?.pause()
            playing = false
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("audio-" + attachment.name)
    }

    private func toggle() {
        if let player {
            if playing { player.pause() } else { player.play() }
            playing.toggle()
            return
        }
        guard !loading else { return }
        loading = true
        failed = false
        loadTask = Task { @MainActor in
            defer { if !Task.isCancelled { loading = false; loadTask = nil } }
            do {
                let file = try await prepareAttachmentFile(sessionActions, threadId: threadId, messageId: messageId, path: attachment.path)
                let item = AVPlayerItem(url: file.item.url)
                let length = try? await item.asset.load(.duration)
                try Task.checkCancellation()
                prepared = file
                duration = length.map(\.seconds).flatMap { $0.isFinite ? $0 : nil } ?? 0
                let next = AVPlayer(playerItem: item)
                player = next
                next.play()
                playing = true
            } catch is CancellationError {
                return
            } catch {
                if !Task.isCancelled { failed = true }
            }
        }
    }
}

// MARK: - Files

/// A document: a coloured tile, its name, and what kind of file it is.
/// Tapping downloads it and opens the preview.
struct FileChipView: View {
    let attachment: DisplayedMessageAttachment
    let threadId: String
    let messageId: String
    /// Your own upload: ChatGPT's 200pt thread chip. A bot's file is the
    /// wider file tile.
    var compact = false
    @Environment(\.sessionActions) private var sessionActions
    @State private var opening = false
    @State private var failed = false
    @State private var preview: FilePreviewItem?
    @State private var previewTask: Task<Void, Never>?

    private var kind: MediaFileKind { MediaFileKind(name: attachment.name) }

    var body: some View {
        Button(action: open) {
            HStack(spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 12.5, style: .continuous).fill(kind.tile)
                    if opening {
                        ProgressView().tint(.white).controlSize(.small)
                    } else {
                        Image(systemName: kind.symbol)
                            .font(.system(size: 17, weight: .medium))
                            .foregroundStyle(.white)
                    }
                }
                .frame(width: 40, height: 40)
                VStack(alignment: .leading, spacing: 1) {
                    Text(attachment.name)
                        .font(.system(size: 15, weight: compact ? .medium : .semibold))
                        .foregroundStyle(Color.primary)
                        .lineLimit(1).truncationMode(.middle)
                    Text(failed ? "Couldn't load this file · Retry" : kind.label)
                        .font(.system(size: 13))
                        .foregroundStyle(failed ? Color.red : GPT.secondaryText)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(compact ? 6 : 10)
            .padding(.trailing, 6)
            .frame(width: compact ? 220 : 300, alignment: .leading)
            .background(compact ? GPT.softFill : GPT.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(compact ? GPT.subtleBorder : GPT.strongBorder, lineWidth: compact ? 1 : 0.5))
            .contentShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(opening)
        .accessibilityLabel("\(kind.label): \(attachment.name)")
        .accessibilityHint("Opens a preview")
        .fullScreenCover(item: $preview) { item in
            FilePreviewView(item: item) { preview = nil }
        }
        .onDisappear {
            previewTask?.cancel()
            previewTask = nil
            opening = false
        }
    }

    private func open() {
        guard !opening, let session = sessionActions else { return }
        opening = true
        failed = false
        previewTask = Task { @MainActor in
            var unfinishedItem: FilePreviewItem?
            defer {
                unfinishedItem?.cleanUp()
                if !Task.isCancelled { opening = false; previewTask = nil }
            }
            do {
                let downloaded = try await session.prepareAttachmentPreview(threadId: threadId, messageId: messageId, path: attachment.path)
                guard let item = FilePreviewItem(downloaded: downloaded) else { failed = true; return }
                unfinishedItem = item
                try Task.checkCancellation()
                preview = item
                unfinishedItem = nil
            } catch is CancellationError {
                return
            } catch {
                if !Task.isCancelled { failed = true }
            }
        }
    }
}

// MARK: - Link previews

/// A link a bot put on a line of its own, as a 360pt card: the page's
/// icon, title and site.
struct LinkPreviewCard: View {
    let url: URL
    let open: (URL) -> Void
    @State private var title: String?
    @State private var icon: UIImage?

    private var host: String { (url.host ?? url.absoluteString).replacingOccurrences(of: "www.", with: "") }

    var body: some View {
        Button { open(url) } label: {
            HStack(spacing: 10) {
                Group {
                    if let icon {
                        Image(uiImage: icon).resizable().scaledToFit().padding(9)
                    } else {
                        Image(systemName: "globe").font(.system(size: 17)).foregroundStyle(GPT.secondaryText)
                    }
                }
                .frame(width: 40, height: 40)
                .background(GPT.iconTile, in: RoundedRectangle(cornerRadius: 12.5, style: .continuous))
                VStack(alignment: .leading, spacing: 1) {
                    Text(title ?? host)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                    Text(host).font(.system(size: 13)).foregroundStyle(GPT.secondaryText).lineLimit(1)
                }
                Spacer(minLength: 0)
                Image(systemName: "arrow.up.right").font(.system(size: 13, weight: .medium)).foregroundStyle(GPT.tertiaryText)
            }
            .padding(6)
            .padding(.trailing, 8)
            .frame(maxWidth: 360, alignment: .leading)
            .background(GPT.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(GPT.strongBorder, lineWidth: 0.5))
            .contentShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Link: \(title ?? host)")
        .task(id: url) {
            if let cached = LinkPreviewCache.shared[url] { title = cached.title; icon = cached.icon; return }
            guard url.scheme == "https" || url.scheme == "http" else { return }
            let provider = LPMetadataProvider()
            provider.timeout = 6
            provider.shouldFetchSubresources = false
            guard let metadata = try? await provider.startFetchingMetadata(for: url) else { return }
            let fetchedTitle = metadata.title
            var fetchedIcon: UIImage?
            if let iconProvider = metadata.iconProvider {
                fetchedIcon = await withCheckedContinuation { continuation in
                    iconProvider.loadObject(ofClass: UIImage.self) { object, _ in
                        continuation.resume(returning: object as? UIImage)
                    }
                }
            }
            LinkPreviewCache.shared[url] = (fetchedTitle, fetchedIcon)
            title = fetchedTitle
            icon = fetchedIcon
        }
    }
}

@MainActor
private final class LinkPreviewCache {
    static let shared = LinkPreviewCache()
    private var entries: [URL: (title: String?, icon: UIImage?)] = [:]
    subscript(url: URL) -> (title: String?, icon: UIImage?)? {
        get { entries[url] }
        set { entries[url] = newValue }
    }
}

/// Links a reply put on a line of their own: those get a preview card.
func standaloneLinks(in text: String) -> [URL] {
    var seen = Set<URL>()
    return text.split(whereSeparator: \.isNewline).compactMap { raw -> URL? in
        var line = raw.trimmingCharacters(in: .whitespaces)
        if line.hasPrefix("<"), line.hasSuffix(">") { line = String(line.dropFirst().dropLast()) }
        guard line.hasPrefix("https://") || line.hasPrefix("http://"), !line.contains(" "),
              let url = URL(string: line), url.host != nil, seen.insert(url).inserted else { return nil }
        return url
    }
}
