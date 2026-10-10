// The mascot colour: the 13 palette swatches as presets, plus any colour at
// all through the system picker. A swatch saves its name ("blue"), so older
// clients keep reading it; a picked colour saves "#RRGGBB". Mirrors the
// desktop's BotProfileAvatarCard.
import CompanionCore
import SwiftUI
import UIKit

struct MascotColorPicker: View {
    /// The bot's stored colour, name or hex.
    let current: String
    var disabled = false
    let pick: (String) async -> Void
    /// Every colour as it is being chosen, before it saves: a swatch tap and
    /// each step of the wheel, so the mascot above can morph live.
    var preview: (String) -> Void = { _ in }

    @State private var custom: Color = .green
    @State private var save: Task<Void, Never>?

    private var currentHex: String { GlyphFaces.resolveColor(current) }
    private var isCustom: Bool { !GlyphFaces.paletteNames.contains(current) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Colour").font(.subheadline).foregroundStyle(.secondary)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 7), spacing: 10) {
                ForEach(GlyphFaces.paletteNames, id: \.self) { name in
                    Button {
                        save?.cancel()
                        preview(name)
                        Task { await pick(name) }
                    } label: {
                        swatch(MausPalette.color(name), selected: current == name)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Use \(name) mascot colour")
                    .accessibilityAddTraits(current == name ? .isSelected : [])
                }
                ColorPicker(selection: Binding(
                    get: { custom },
                    set: { next in
                        custom = next
                        // the wheel reports every drag step; save where it settles
                        save?.cancel()
                        guard let hex = Self.hex(next), hex != currentHex else { return }
                        preview(hex)
                        save = Task {
                            try? await Task.sleep(for: .milliseconds(450))
                            guard !Task.isCancelled else { return }
                            await pick(hex)
                        }
                    }
                ), supportsOpacity: false) {
                    Text("Any colour")
                }
                .labelsHidden()
                .frame(width: 30, height: 30)
                .overlay(Circle().stroke(isCustom ? Color.primary : Color.clear, lineWidth: 2).padding(-3))
                .accessibilityLabel("Pick any mascot colour")
            }
            if isCustom {
                Text(currentHex).font(.caption.monospaced()).foregroundStyle(.secondary)
            }
        }
        .disabled(disabled)
        .padding(.vertical, 6)
        .onAppear { custom = Color(hex: currentHex) }
        .onChange(of: current) { _, _ in custom = Color(hex: currentHex) }
    }

    private func swatch(_ color: Color, selected: Bool) -> some View {
        Circle()
            .fill(color)
            .overlay(Circle().stroke(Color(.separator), lineWidth: 0.5))
            .frame(width: 30, height: 30)
            .overlay(Circle().stroke(selected ? Color.primary : Color.clear, lineWidth: 2).padding(-3))
            .frame(maxWidth: .infinity)
    }

    /// "#RRGGBB" in sRGB, uppercase — the form the server stores.
    static func hex(_ color: Color) -> String? {
        guard let srgb = CGColorSpace(name: CGColorSpace.sRGB),
              let converted = UIColor(color).cgColor.converted(to: srgb, intent: .defaultIntent, options: nil),
              let parts = converted.components, parts.count >= 3 else { return nil }
        func byte(_ value: CGFloat) -> Int { Int((min(max(value, 0), 1) * 255).rounded()) }
        return String(format: "#%02X%02X%02X", byte(parts[0]), byte(parts[1]), byte(parts[2]))
    }
}
