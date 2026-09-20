import Foundation

/// Pure state for the section creator's draw-through gesture.
///
/// The view owns the 160 ms timer. Every hovered cell gets a unique candidate
/// token, so a timer that finishes after the finger has moved cannot commit a
/// stale bot. Keeping this independent of SwiftUI makes the fiddly gesture
/// rules deterministic and cheap to test.
public struct SectionSelection: Equatable, Sendable {
    public struct Candidate: Equatable, Sendable {
        public let id: String
        fileprivate let generation: UInt
    }

    public enum Commit: Equatable, Sendable {
        case added(String)
        case visited(String)
        case backtracked(removed: [String])
        case limitReached(String)
        case unchanged

        public var givesFeedback: Bool {
            switch self {
            case .added, .visited, .backtracked: true
            case .limitReached, .unchanged: false
            }
        }
    }

    public private(set) var selectedIDs: [String]
    public let maximumCount: Int
    public private(set) var candidate: Candidate?
    public private(set) var gestureTrail: [String] = []
    public private(set) var isDragging = false

    private var gestureBase: [String] = []
    private var settledID: String?
    private var generation: UInt = 0

    public init(selectedIDs: [String] = [], maximumCount: Int = .max) {
        self.maximumCount = max(0, maximumCount)
        self.selectedIDs = Array(Self.unique(selectedIDs).prefix(self.maximumCount))
    }

    public func contains(_ id: String) -> Bool {
        selectedIDs.contains(id)
    }

    /// Accessible tap fallback. Buttons and VoiceOver use exactly the same
    /// ordered selection as the drawing gesture.
    @discardableResult
    public mutating func toggle(_ id: String) -> Bool {
        guard !isDragging else { return false }
        if let index = selectedIDs.firstIndex(of: id) {
            selectedIDs.remove(at: index)
            return true
        } else {
            guard selectedIDs.count < maximumCount else { return false }
            selectedIDs.append(id)
            return true
        }
    }

    public mutating func selectAll(_ ids: [String]) {
        guard !isDragging else { return }
        selectedIDs = Array(Self.unique(ids).prefix(maximumCount))
    }

    public mutating func clear() {
        cancelGesture()
        selectedIDs = []
    }

    /// Starts a new trail without disturbing selections made by accessible
    /// taps or an earlier gesture.
    @discardableResult
    public mutating func beginDrag(over id: String?) -> Candidate? {
        cancelCandidate()
        isDragging = true
        gestureBase = selectedIDs
        gestureTrail = []
        settledID = nil
        return moveDrag(over: id)
    }

    /// Changes the dwell target. Passing `nil` means the finger is in a grid
    /// gap and invalidates any outstanding timer.
    @discardableResult
    public mutating func moveDrag(over id: String?) -> Candidate? {
        guard isDragging else { return nil }

        if id == settledID {
            cancelCandidate()
            return nil
        }
        if candidate?.id == id {
            return candidate
        }

        cancelCandidate()
        guard let id else {
            settledID = nil
            return nil
        }
        settledID = nil
        let next = Candidate(id: id, generation: generation)
        candidate = next
        return next
    }

    /// Commits only the candidate that is still under the finger. Revisiting
    /// an earlier trail cell removes the tail; preselected bots remain in the
    /// base selection even when the drawn tail is shortened.
    @discardableResult
    public mutating func commit(_ expected: Candidate) -> Commit {
        guard isDragging, candidate == expected else { return .unchanged }
        candidate = nil
        settledID = expected.id

        if let index = gestureTrail.firstIndex(of: expected.id) {
            guard index < gestureTrail.index(before: gestureTrail.endIndex) else {
                return .unchanged
            }
            let removed = Array(gestureTrail[gestureTrail.index(after: index)...])
            gestureTrail.removeSubrange(gestureTrail.index(after: index)...)
            rebuildSelection()
            return .backtracked(removed: removed)
        }

        if !gestureBase.contains(expected.id), selectedIDs.count >= maximumCount {
            return .limitReached(expected.id)
        }
        gestureTrail.append(expected.id)
        let wasPreselected = gestureBase.contains(expected.id)
        rebuildSelection()
        return wasPreselected ? .visited(expected.id) : .added(expected.id)
    }

    public mutating func endDrag() {
        cancelCandidate()
        isDragging = false
        settledID = nil
        gestureBase = []
        gestureTrail = []
    }

    private mutating func cancelGesture() {
        cancelCandidate()
        isDragging = false
        settledID = nil
        gestureBase = []
        gestureTrail = []
    }

    private mutating func cancelCandidate() {
        generation &+= 1
        candidate = nil
    }

    private mutating func rebuildSelection() {
        selectedIDs = Self.unique(gestureBase + gestureTrail)
    }

    private static func unique(_ ids: [String]) -> [String] {
        var seen = Set<String>()
        return ids.filter { seen.insert($0).inserted }
    }
}

/// Small geometry values keep hit testing usable from CompanionCore without
/// importing SwiftUI or leaking a particular grid implementation into it.
public struct SectionGridPoint: Equatable, Sendable {
    public var x: Double
    public var y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

public struct SectionGridCellFrame: Equatable, Sendable {
    public var id: String
    public var minX: Double
    public var minY: Double
    public var maxX: Double
    public var maxY: Double

    public init(id: String, minX: Double, minY: Double, maxX: Double, maxY: Double) {
        self.id = id
        self.minX = minX
        self.minY = minY
        self.maxX = maxX
        self.maxY = maxY
    }

    public func contains(_ point: SectionGridPoint) -> Bool {
        guard maxX > minX, maxY > minY else { return false }
        // Half-open bounds make a shared edge deterministic.
        return point.x >= minX && point.x < maxX && point.y >= minY && point.y < maxY
    }
}

public enum SectionGridHitTesting {
    public static func cellID(
        at point: SectionGridPoint,
        in frames: [SectionGridCellFrame]
    ) -> String? {
        frames.first(where: { $0.contains(point) })?.id
    }
}
