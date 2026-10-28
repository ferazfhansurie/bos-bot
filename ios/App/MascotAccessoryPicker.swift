import CompanionCore
import SwiftUI

/// One row per slot: none, then every piece for it, each tried on the bot's
/// own mascot. A tap picks it; the caller previews and saves.
struct MascotAccessoryPicker: View {
    let worn: MascotAccessories
    let color: String
    let bodyId: String?
    let eyeStyle: MascotEyeStyle
    var disabled = false
    let pick: (MascotAccessorySlot, String?) -> Void

    var body: some View {
        ForEach(MascotAccessorySlot.allCases, id: \.self) { slot in
            VStack(alignment: .leading, spacing: 2) {
                Text(slot.title).font(.subheadline).foregroundStyle(.secondary)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        tile(slot: slot, id: nil, name: "None")
                        ForEach(MascotAccessoryCatalog.pieces(for: slot)) { piece in
                            tile(slot: slot, id: piece.id, name: piece.name)
                        }
                    }
                    // room for a hat rising over the tile's top edge
                    .padding(.top, 8)
                    .padding(.horizontal, 2)
                }
                .scrollClipDisabled()
            }
            .padding(.vertical, 6)
        }
    }

    private func tile(slot: MascotAccessorySlot, id: String?, name: String) -> some View {
        let chosen = worn[slot] == id
        return Button {
            pick(slot, id)
        } label: {
            VStack(spacing: 4) {
                FlatBotMark(color: color, bodyId: bodyId, eyeStyle: eyeStyle,
                            accessories: id.map { MascotAccessories([slot: $0]) })
                    .frame(width: 40, height: 40)
                    .padding(9)
                    .background(Circle().fill(Color.primary.opacity(chosen ? 0.10 : 0.04)))
                    .overlay(Circle().strokeBorder(chosen ? Color.secondary : Color.clear, lineWidth: 2))
                Text(name).font(.caption2).foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.8)
            }
            .frame(width: 70)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityLabel("\(slot.title): \(name)")
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }
}
