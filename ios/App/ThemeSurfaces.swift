// Themes that colour the whole app, not just its accent.
//
// The app paints almost nothing itself: lists, forms, sheets and the chat all
// sit on UIKit's semantic backgrounds. So rather than touch every screen, the
// six semantic background getters are pointed at the chosen theme once, at
// launch. Anything that asks UIKit or SwiftUI for "the background" — including
// screens added later — comes out in the theme. Classic hands every getter
// back to the system, so it looks exactly as the app always has.
//
// Palettes come from the Mac's skins (src/styles.css `[data-skin=…]`); where a
// skin only exists in one brightness, its other half is drawn to match.
import SwiftUI
import UIKit
import ObjectiveC

struct ThemePalette {
    let app: UInt32       // --color-app: the page
    let panel: UInt32     // --color-panel: a step in
    let raised: UInt32    // --color-raised: bubbles, raised rows
    let card: UInt32      // --color-card
    let composer: UInt32  // --color-composer: rows on a grouped page
    let accent: UInt32
}

extension AppTheme {
    /// nil means the system's own backgrounds.
    var light: ThemePalette? {
        switch self {
        case .midnight: nil
        case .pink: ThemePalette(app: 0xFDF7F9, panel: 0xF9EEF2, raised: 0xF2DDE5, card: 0xF7E7ED, composer: 0xFFFBFC, accent: 0xC2185B)
        case .atelier: ThemePalette(app: 0xF5F1EB, panel: 0xEFE9E0, raised: 0xE8E0D4, card: 0xFBF8F2, composer: 0xFFFFFF, accent: 0xA05F25)
        case .foundry: ThemePalette(app: 0xFAF5EA, panel: 0xF3EAD8, raised: 0xEADDC4, card: 0xFBF4E6, composer: 0xFFFDF8, accent: 0xB67B29)
        case .lagoon: ThemePalette(app: 0xE9F2F1, panel: 0xDFECEB, raised: 0xD1E4E2, card: 0xF3F8F7, composer: 0xFFFFFF, accent: 0x11736D)
        case .graphite: ThemePalette(app: 0xF1F2F4, panel: 0xE8EAED, raised: 0xDEE1E6, card: 0xF7F8F9, composer: 0xFFFFFF, accent: 0x4F6F96)
        case .linen: ThemePalette(app: 0xF5F6F8, panel: 0xECEFF3, raised: 0xE0E5EC, card: 0xF9FAFB, composer: 0xFFFFFF, accent: 0x355F8A)
        case .dusk: ThemePalette(app: 0xF6F3F8, panel: 0xEEE8F2, raised: 0xE3DAEA, card: 0xFAF7FC, composer: 0xFFFFFF, accent: 0x765683)
        case .matcha: ThemePalette(app: 0xF4F6EF, panel: 0xEAEFE2, raised: 0xDDE5D2, card: 0xF8FAF4, composer: 0xFFFFFF, accent: 0x4F7A3A)
        case .sunset: ThemePalette(app: 0xFDF5F0, panel: 0xF8E9DF, raised: 0xF1DACB, card: 0xFBF0E9, composer: 0xFFFBF8, accent: 0xD0582A)
        }
    }

    var dark: ThemePalette? {
        switch self {
        case .midnight: nil
        case .pink: ThemePalette(app: 0x141016, panel: 0x1C1620, raised: 0x2E2331, card: 0x261D29, composer: 0x2E2331, accent: 0xC73A6E)
        case .atelier: ThemePalette(app: 0x14110E, panel: 0x1B1713, raised: 0x2A241D, card: 0x221D17, composer: 0x2A241D, accent: 0xD08A4A)
        case .foundry: ThemePalette(app: 0x100E0B, panel: 0x171410, raised: 0x262019, card: 0x1E1A14, composer: 0x262019, accent: 0xD99A3E)
        case .lagoon: ThemePalette(app: 0x0C1413, panel: 0x121C1B, raised: 0x21302E, card: 0x1A2725, composer: 0x21302E, accent: 0x2FA39B)
        case .graphite: ThemePalette(app: 0x111214, panel: 0x181A1D, raised: 0x2A2D32, card: 0x22252A, composer: 0x2A2D32, accent: 0x6A8FBD)
        case .linen: ThemePalette(app: 0x0F1216, panel: 0x161A20, raised: 0x262C35, card: 0x1E232A, composer: 0x262C35, accent: 0x5B8BC0)
        case .dusk: ThemePalette(app: 0x121014, panel: 0x19161C, raised: 0x2B2630, card: 0x231F27, composer: 0x2B2630, accent: 0x9A74AB)
        case .matcha: ThemePalette(app: 0x0F120D, panel: 0x161B13, raised: 0x252D20, card: 0x1D241A, composer: 0x252D20, accent: 0x7FAE63)
        case .sunset: ThemePalette(app: 0x150F0C, panel: 0x1D1511, raised: 0x2F231C, card: 0x261C16, composer: 0x2F231C, accent: 0xEF7D4A)
        }
    }

    func palette(_ style: UIUserInterfaceStyle) -> ThemePalette? {
        style == .dark ? dark : light
    }
}

enum ThemeSurfaces {
    enum Slot: CaseIterable {
        case system, secondary, tertiary, grouped, secondaryGrouped, tertiaryGrouped

        var selector: Selector {
            switch self {
            case .system: #selector(getter: UIColor.systemBackground)
            case .secondary: #selector(getter: UIColor.secondarySystemBackground)
            case .tertiary: #selector(getter: UIColor.tertiarySystemBackground)
            case .grouped: #selector(getter: UIColor.systemGroupedBackground)
            case .secondaryGrouped: #selector(getter: UIColor.secondarySystemGroupedBackground)
            case .tertiaryGrouped: #selector(getter: UIColor.tertiarySystemGroupedBackground)
            }
        }

        // Plain screens: app → panel → raised, as on the Mac. Grouped lists and
        // forms: a slightly deeper page with lighter rows on top, the way the
        // Mac's panels sit on its app colour.
        func hex(in palette: ThemePalette) -> UInt32 {
            switch self {
            case .system: palette.app
            case .secondary: palette.panel
            case .tertiary: palette.raised
            case .grouped: palette.panel
            case .secondaryGrouped: palette.composer
            case .tertiaryGrouped: palette.card
            }
        }
    }

    private typealias Getter = @convention(c) (AnyClass, Selector) -> UIColor

    private static var installed = false
    private static var originals: [Selector: Getter] = [:]
    private static var cache: [Slot: UIColor] = [:]
    private(set) static var current: AppTheme = .midnight

    static var stored: AppTheme {
        AppTheme(rawValue: UserDefaults.standard.string(forKey: PrefKey.theme) ?? "") ?? .midnight
    }

    /// Idempotent. Call before the first view is built.
    static func install() {
        guard !installed else { return }
        installed = true
        for slot in Slot.allCases {
            guard let method = class_getClassMethod(UIColor.self, slot.selector) else { continue }
            originals[slot.selector] = unsafeBitCast(method_getImplementation(method), to: Getter.self)
            let selector = slot.selector
            let block: @convention(block) (AnyObject) -> UIColor = { cls in
                if let themed = cache[slot] { return themed }
                return originals[selector]!(cls as! AnyClass, selector)
            }
            method_setImplementation(method, imp_implementationWithBlock(block))
        }
        apply(stored)
    }

    /// Points every background at `theme`. Views already on screen keep the
    /// colours they resolved; the root re-identifies itself to pick these up.
    static func apply(_ theme: AppTheme) {
        current = theme
        cache = [:]
        if theme.light != nil || theme.dark != nil {
            for slot in Slot.allCases {
                cache[slot] = UIColor { trait in
                    guard let palette = theme.palette(trait.userInterfaceStyle) ?? theme.light ?? theme.dark else { return .clear }
                    return UIColor(hex: slot.hex(in: palette))
                }
            }
        }
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        for window in windows {
            window.tintColor = theme.accentUIColor
            window.backgroundColor = UIColor.systemBackground
        }
    }
}

extension AppTheme {
    var accentUIColor: UIColor {
        UIColor { trait in
            if let palette = palette(trait.userInterfaceStyle) { return UIColor(hex: palette.accent) }
            return UIColor(red: 0x37 / 255, green: 0x7F / 255, blue: 0xE6 / 255, alpha: 1)
        }
    }

    /// The bot's bubble: the theme's raised surface, or the app's own greys.
    var bubbleUIColor: UIColor {
        UIColor { trait in
            if let palette = palette(trait.userInterfaceStyle) { return UIColor(hex: palette.raised) }
            return trait.userInterfaceStyle == .dark
                ? UIColor(red: 0.149, green: 0.149, blue: 0.161, alpha: 1)   // #262629
                : UIColor(red: 0.914, green: 0.914, blue: 0.922, alpha: 1)   // #E9E9EB
        }
    }
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}
