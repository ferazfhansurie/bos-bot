// Puts `MascotAccessoryArt` on a SwiftUI canvas. Every surface that draws a
// mascot calls `MascotAccessoryArt.draw` right after the eyes, with the rect
// its body's 100 box fills; `MascotAccessoriesLayer` is the same thing as a
// view to stack over a mascot drawn elsewhere (a live activity, a widget).
import SwiftUI

extension MascotAccessoryArt {
    /// Draws what `accessories` puts on the body whose 100 box fills `box`.
    /// Nothing at all when it wears nothing.
    public static func draw(_ accessories: MascotAccessories?, in context: inout GraphicsContext, box: CGRect,
                            bodyId: String?, color: String?, face: MascotFace? = nil) {
        let shapes = shapes(accessories, bodyId: bodyId, color: color, face: face)
        guard !shapes.isEmpty else { return }
        var layer = context
        layer.translateBy(x: box.minX, y: box.minY)
        layer.scaleBy(x: box.width / 100, y: box.height / 100)
        for shape in shapes {
            let path = Path(shape.path)
            if let fill = shape.fill {
                layer.fill(path, with: .color(swatch(fill).opacity(shape.fillOpacity)))
            }
            if let stroke = shape.stroke {
                layer.stroke(path, with: .color(swatch(stroke).opacity(shape.strokeOpacity)),
                             style: StrokeStyle(lineWidth: shape.lineWidth, lineCap: shape.lineCap, lineJoin: shape.lineJoin))
            }
        }
    }

    static func swatch(_ hex: String) -> Color {
        let c = rgb(hex)
        return Color(.sRGB, red: c[0] / 255, green: c[1] / 255, blue: c[2] / 255, opacity: 1)
    }
}

/// A bot's accessories alone, to stack over a mascot drawn elsewhere. Give
/// it the mascot's own frame: the body's 100 box fills the largest centred
/// square of it, and the art may spill past it (a hat rises over the body)
/// without being clipped. `face` defaults to the glyph face.
public struct MascotAccessoriesLayer: View {
    public var accessories: MascotAccessories?
    public var bodyId: String?
    public var color: String?
    public var face: MascotFace?

    public init(_ accessories: MascotAccessories?, bodyId: String?, color: String?, face: MascotFace? = nil) {
        self.accessories = accessories
        self.bodyId = bodyId
        self.color = color
        self.face = face
    }

    public var body: some View {
        if let accessories, !accessories.isEmpty {
            GeometryReader { proxy in
                let size = proxy.size
                Canvas { context, canvas in
                    let side = min(size.width, size.height)
                    let box = CGRect(x: (canvas.width - side) / 2, y: (canvas.height - side) / 2, width: side, height: side)
                    MascotAccessoryArt.draw(accessories, in: &context, box: box, bodyId: bodyId, color: color, face: face)
                }
                // twice the frame, centred on it, so nothing clips
                .frame(width: size.width * 2, height: size.height * 2)
                .offset(x: -size.width / 2, y: -size.height / 2)
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }
}
