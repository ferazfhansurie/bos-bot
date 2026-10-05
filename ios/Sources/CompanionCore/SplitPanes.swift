// Two chats side by side, on a wide screen.
//
// The desktop opens a second bot thread in a side panel beside whatever is
// on the left; an iPad in a regular-width window does the same. The panes
// share the detail area by a fraction the person drags and the app keeps.
// What that fraction may be — and when there is room for a split, or for
// the roster beside it — is decided here, so the rules are tested without
// a view.
//
// Pure: no UIKit, and Double rather than CGFloat so `swift test` runs it.
import Foundation

public enum SplitPanes {
    /// Narrower than this and a chat's composer and bubbles start to wrap
    /// word by word. Each pane keeps at least this much.
    public static let minimumPaneWidth: Double = 320
    /// The draggable divider: a hairline with a grab area around it.
    public static let handleWidth: Double = 12
    /// The roster column beside the chats.
    public static let sidebarWidth: Double = 340
    /// Where a fresh split, or a double-tapped divider, starts.
    public static let defaultFraction: Double = 0.5

    /// Whether `width` can hold two chats at their minimum, the roster aside.
    public static func fitsTwoPanes(in width: Double) -> Bool {
        width >= minimumPaneWidth * 2 + handleWidth
    }

    /// Whether the roster column shows beside `panes` open chats. With no
    /// chat open it always shows — the roster is the only way in — and with
    /// chats it steps aside before squeezing one below its minimum.
    public static func showsSidebar(in width: Double, panes: Int) -> Bool {
        guard panes > 0 else { return true }
        let needed = panes > 1 ? minimumPaneWidth * 2 + handleWidth : minimumPaneWidth
        return width - sidebarWidth >= needed
    }

    /// The primary pane's share of `width`, held so neither pane drops below
    /// its minimum. A stored value that is garbage, or a window too narrow to
    /// honour both minimums, falls back to an even split.
    public static func clamp(_ fraction: Double, in width: Double) -> Double {
        let usable = width - handleWidth
        guard usable > 0, fraction.isFinite else { return defaultFraction }
        let floor = minimumPaneWidth / usable
        guard floor < defaultFraction else { return defaultFraction }
        return min(max(fraction, floor), 1 - floor)
    }

    /// The fraction after dragging the divider `translation` points from
    /// where it sat at `fraction` when the drag began.
    public static func dragged(from fraction: Double, by translation: Double, in width: Double) -> Double {
        let usable = width - handleWidth
        guard usable > 0 else { return defaultFraction }
        return clamp(clamp(fraction, in: width) + translation / usable, in: width)
    }

    /// Point widths of the primary and side panes for `fraction` of `width`.
    public static func paneWidths(_ fraction: Double, in width: Double) -> (primary: Double, side: Double) {
        let usable = max(0, width - handleWidth)
        let primary = (usable * clamp(fraction, in: width)).rounded()
        return (primary, usable - primary)
    }
}
