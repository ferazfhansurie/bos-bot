// The home and lock screen widgets: your bots' faces, who is working and
// who is waiting on you. A tap opens that bot's thread.
//
// The app writes a roster snapshot into the App Group whenever a bot's
// status changes (LiveActivities.swift) and asks for a reload. A widget is a
// snapshot, so the life comes from the timeline: every few minutes the next
// entry gives each face its next beat. A working bot moves through
// thinking, searching and working; a bot waiting on you keeps looking at you;
// a resting bot stays calm and only now and then glances up and smiles.
// WidgetKit animates between entries with the faces' transitions, and stops
// drawing them when nobody is looking.
import CompanionCore
import SwiftUI
import WidgetKit

struct BotsEntry: TimelineEntry {
    let date: Date
    /// nil until the app has run once.
    let roster: BotRosterSnapshot?
    /// Which beat of the faces' loop this entry shows.
    let beat: Int
}

struct BotsProvider: TimelineProvider {
    /// One beat every few minutes for an hour, then ask again.
    static let beatLength: TimeInterval = 4 * 60
    static let beats = 15

    func placeholder(in context: Context) -> BotsEntry {
        BotsEntry(date: Date(), roster: Self.sample, beat: 0)
    }

    func getSnapshot(in context: Context, completion: @escaping (BotsEntry) -> Void) {
        let roster = BotRosterStore.load() ?? (context.isPreview ? Self.sample : nil)
        completion(BotsEntry(date: Date(), roster: roster?.settled(), beat: 0))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<BotsEntry>) -> Void) {
        let now = Date()
        let stored = BotRosterStore.load()
        let entries = (0..<Self.beats).map { beat in
            let date = now.addingTimeInterval(Double(beat) * Self.beatLength)
            return BotsEntry(date: date, roster: stored?.settled(now: date), beat: beat)
        }
        completion(Timeline(entries: entries, policy: .atEnd))
    }

    /// The widget gallery's preview before the app has written anything.
    static let sample = BotRosterSnapshot(bots: [
        BotGlance(id: "bos", name: "bos", color: "teal", body: "circle", eyes: nil, status: "working",
                  face: "working", line: "Building the widgets", threadId: nil, threadTitle: "bos bot feels alive", since: Date()),
        BotGlance(id: "oracle", name: "oracle", color: "coral", body: "sun", eyes: nil, status: "needsYou",
                  face: "listening", line: "Ship the nightly run?", threadId: nil, threadTitle: nil, since: Date()),
    ], updatedAt: Date())
}

extension BotGlance {
    var accent: Color { MausPalette.color(color) }

    /// "working", "needs you", "done", or nothing at rest.
    var statusWord: String {
        switch status {
        case "needsYou": return "needs you"
        case "working": return "working"
        case "done": return "done"
        default: return ""
        }
    }

    /// A stable per-bot offset, so the team does not move in lockstep.
    private var seed: Int { id.unicodeScalars.reduce(0) { $0 &+ Int($1.value) } }

    /// The face for one beat of the timeline.
    func face(beat: Int, at date: Date) -> MausState {
        let current = MausState(rawValue: face) ?? .idle
        switch status {
        case "needsYou":
            return .listening
        case "working":
            // start on what it is really doing, then drift through the work
            let loop: [MausState] = [.thinking, .searching, .reading, .writing, .working]
            let start = loop.firstIndex(of: current) ?? 2
            return beat == 0 ? current : loop[(start + beat) % loop.count]
        case "done":
            return beat == 0 ? .celebrate : .happy
        default:
            // calm when left alone: a glance and a smile now and then
            let hour = Calendar.current.component(.hour, from: date)
            if hour < 7 { return .idle }
            return (beat + seed % 5) % 5 == 4 ? .happy : .idle
        }
    }

    /// A small lean that changes with each beat, so a still widget is not a
    /// frozen one. Busy bots lean more; resting ones barely.
    func lean(beat: Int) -> Double {
        let swing: [Double] = [0, 4, -3, 2, -4, 3]
        let calm = isBusy ? 1.0 : 0.4
        return swing[(beat + seed % 3) % swing.count] * calm
    }
}

struct BotsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: BotGlanceWidgetKind.bots, provider: BotsProvider()) { entry in
            BotsWidgetView(entry: entry)
        }
        .configurationDisplayName("Your bots")
        .description("Who is working and who is waiting on you. Tap a face to open its thread.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline])
        .contentMarginsDisabled()
    }
}

struct BotsWidgetView: View {
    let entry: BotsEntry
    @Environment(\.widgetFamily) private var family

    private var bots: [BotGlance] { entry.roster?.ranked ?? [] }
    /// The bot that matters most right now: waiting on you, then working.
    private var lead: BotGlance? { bots.first }

    var body: some View {
        Group {
            if bots.isEmpty {
                Empty(family: family)
            } else {
                switch family {
                case .systemSmall: SmallBots(lead: lead!, others: Array(bots.dropFirst()), entry: entry)
                case .systemMedium: MediumBots(bots: Array(bots.prefix(4)), entry: entry)
                case .accessoryCircular: CircularBot(bot: lead!, entry: entry)
                case .accessoryRectangular: RectangularBot(bot: lead!, others: bots.dropFirst().filter(\.isBusy).count, entry: entry)
                case .accessoryInline: InlineBots(bots: bots)
                default: SmallBots(lead: lead!, others: Array(bots.dropFirst()), entry: entry)
                }
            }
        }
        .widgetURL(lead?.link ?? URL(string: "bosbot://"))
        .containerBackground(for: .widget) {
            Color(uiColor: .systemBackground)
        }
    }
}

/// A bot's face that changes with the timeline, with a soft spring between
/// beats. Under reduce motion the faces only fade.
private struct BeatFace: View {
    let bot: BotGlance
    let entry: BotsEntry
    let size: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let face = bot.face(beat: entry.beat, at: entry.date)
        MausFaceStill(color: bot.color, state: face, size: size, bodyId: bot.body,
                      eyeStyle: MascotEyeStyle(stored: bot.eyes))
            .rotationEffect(.degrees(reduceMotion ? 0 : bot.lean(beat: entry.beat)))
            .id("\(bot.id)-\(face.rawValue)")
            .transition(reduceMotion ? .opacity : .scale(scale: 0.82).combined(with: .opacity))
            .animation(reduceMotion ? .easeInOut(duration: 0.3) : .spring(duration: 0.55, bounce: 0.45), value: face)
            .frame(width: size, height: size)
            .accessibilityLabel("\(bot.name), \(bot.statusWord.isEmpty ? "here" : bot.statusWord)")
    }
}

/// The face inside a ring in the bot's colour while it is busy.
private struct RingFace: View {
    let bot: BotGlance
    let entry: BotsEntry
    let size: CGFloat

    var body: some View {
        let ring = max(2, size * 0.05)
        ZStack {
            if bot.isWorking, let count = bot.stepCount, count >= 2, let index = bot.stepIndex {
                PlanSegments(index: index, count: count, color: bot.accent, lineWidth: ring)
            } else if bot.isBusy || bot.isDone {
                Circle().stroke(bot.accent.opacity(bot.needsYou ? 1 : 0.55), lineWidth: ring)
            }
            BeatFace(bot: bot, entry: entry, size: size * 0.74)
        }
        .frame(width: size, height: size)
    }
}

private struct StatusText: View {
    let bot: BotGlance

    var body: some View {
        HStack(spacing: 4) {
            Text(bot.name).foregroundStyle(.primary)
            if !bot.statusWord.isEmpty {
                Text("·").foregroundStyle(.tertiary)
                Text(bot.statusWord).foregroundStyle(bot.needsYou || bot.isDone ? bot.accent : .secondary)
            }
        }
        .font(.system(size: 13, weight: .semibold))
        .lineLimit(1)
    }
}

/// Working time that ticks on its own, without a reload.
private struct Elapsed: View {
    let bot: BotGlance

    var body: some View {
        if bot.isWorking, let since = bot.since {
            Text(since, style: .timer)
                .font(.system(size: 12, weight: .medium).monospacedDigit())
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.trailing)
        }
    }
}

private struct SmallBots: View {
    let lead: BotGlance
    let others: [BotGlance]
    let entry: BotsEntry

    var body: some View {
        // big face, then name, one state word and one line: this size is
        // also the one CarPlay's widgets screen draws, so it must read at
        // a glance and nothing wraps
        let team = [lead] + others
        let waiting = team.filter(\.needsYou).count
        let summary = CarGlance.summary(working: team.filter(\.isWorking).count, needsYou: waiting)
        VStack(alignment: .leading, spacing: 1) {
            HStack(alignment: .top) {
                RingFace(bot: lead, entry: entry, size: 64)
                Spacer(minLength: 0)
                // the rest of the team, small, in a row
                HStack(spacing: -4) {
                    ForEach(others.prefix(3)) { bot in
                        BeatFace(bot: bot, entry: entry, size: 22)
                    }
                }
            }
            Spacer(minLength: 4)
            HStack(spacing: 4) {
                Text(lead.fraction.map { "\(lead.name) · \($0)" } ?? lead.name)
                Spacer(minLength: 2)
                Elapsed(bot: lead)
            }
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(.secondary)
            Text(lead.statusWord.isEmpty ? "free" : lead.statusWord)
                .font(.system(size: 20, weight: .bold))
                .foregroundStyle(lead.needsYou || lead.isDone ? lead.accent : .primary)
            Text(summary ?? CarGlance.shortTitle(lead.threadTitle) ?? (lead.line.isEmpty ? "all quiet" : lead.line))
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
        }
        .lineLimit(1)
        .minimumScaleFactor(0.8)
        .padding(14)
    }
}

private struct MediumBots: View {
    let bots: [BotGlance]
    let entry: BotsEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 0) {
                ForEach(bots) { bot in
                    Link(destination: bot.link ?? URL(string: "bosbot://")!) {
                        VStack(spacing: 5) {
                            RingFace(bot: bot, entry: entry, size: 52)
                            Text(bot.name)
                                .font(.system(size: 12, weight: .semibold))
                                .lineLimit(1)
                            Text(bot.statusWord.isEmpty ? " " : bot.statusWord)
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(bot.needsYou || bot.isDone ? bot.accent : .secondary)
                                .lineLimit(1)
                        }
                        .frame(maxWidth: .infinity)
                    }
                }
            }
            if let lead = bots.first, lead.isBusy || lead.isDone, !lead.line.isEmpty {
                HStack(spacing: 6) {
                    Circle().fill(lead.accent).frame(width: 6, height: 6)
                    if let title = lead.threadTitle {
                        Text(title)
                            .font(.system(size: 12, weight: .semibold))
                            .lineLimit(1)
                            .layoutPriority(1)
                    }
                    Text(lead.line)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    if let fraction = lead.fraction {
                        Text(fraction)
                            .font(.system(size: 12, weight: .semibold).monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    Elapsed(bot: lead)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 14)
    }
}

private struct CircularBot: View {
    let bot: BotGlance
    let entry: BotsEntry

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            if bot.isBusy {
                Circle().stroke(.primary.opacity(bot.needsYou ? 0.9 : 0.4), lineWidth: 2).padding(1)
            }
            BeatFace(bot: bot, entry: entry, size: 38)
        }
        .widgetAccentable()
    }
}

private struct RectangularBot: View {
    let bot: BotGlance
    let others: Int
    let entry: BotsEntry

    var body: some View {
        HStack(spacing: 8) {
            BeatFace(bot: bot, entry: entry, size: 34)
                .widgetAccentable()
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    Text(bot.name).font(.system(size: 14, weight: .semibold))
                    if !bot.statusWord.isEmpty {
                        Text(bot.statusWord).font(.system(size: 13)).opacity(0.7)
                    }
                    if let fraction = bot.fraction {
                        Text(fraction).font(.system(size: 13).monospacedDigit()).opacity(0.7)
                    }
                }
                .lineLimit(1)
                if let title = bot.threadTitle, bot.isBusy || bot.isDone {
                    Text(title).font(.system(size: 13, weight: .medium)).lineLimit(1)
                }
                Text(bot.line.isEmpty ? (others > 0 ? "+\(others) busy" : "all quiet") : bot.line)
                    .font(.system(size: 13))
                    .lineLimit(bot.threadTitle == nil ? 2 : 1)
                    .opacity(0.8)
            }
            Spacer(minLength: 0)
        }
    }
}

private struct InlineBots: View {
    let bots: [BotGlance]

    var body: some View {
        if let waiting = bots.first(where: \.needsYou) {
            Label("\(waiting.name) needs you", systemImage: "hand.raised.fill")
        } else if let working = bots.first(where: \.isWorking) {
            let more = bots.filter(\.isWorking).count - 1
            Label(more > 0 ? "\(working.name) +\(more) working" : "\(working.name) is working", systemImage: "ellipsis")
        } else if let done = bots.first(where: \.isDone) {
            Label("\(done.name) is done", systemImage: "checkmark")
        } else {
            Label("bots all quiet", systemImage: "circle")
        }
    }
}

private struct Empty: View {
    let family: WidgetFamily

    var body: some View {
        switch family {
        case .accessoryInline:
            Text("open BOS once")
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                MausFaceStill(color: "green", state: .idle, size: 36)
            }
        default:
            VStack(spacing: 8) {
                MausFaceStill(color: "green", state: .idle, size: 44)
                Text("open BOS once to see your bots")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding(12)
        }
    }
}
