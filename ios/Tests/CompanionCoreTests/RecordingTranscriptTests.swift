import XCTest
@testable import CompanionCore

final class RecordingTranscriptTests: XCTestCase {
    func testLateFinalStaysBeforeNewSegment() {
        var text = Dictation.RecordingTranscript()
        text.apply(segment: 1, text: "first")
        text.apply(segment: 2, text: "next sentence")
        text.apply(segment: 1, text: "first sentence.", endsUtterance: true)
        XCTAssertEqual(text.text, "first sentence. next sentence")
    }

    func testRepeatedWordsAcrossRecognitionTasksArePreserved() {
        var text = Dictation.RecordingTranscript()
        text.apply(segment: 1, text: "yes", endsUtterance: true)
        text.apply(segment: 2, text: "yes", endsUtterance: true)
        XCTAssertEqual(text.text, "yes yes")
    }

    func testSilenceDoesNotErasePreviousSegments() {
        var text = Dictation.RecordingTranscript()
        for segment in 1...80 {
            text.apply(segment: segment, text: segment % 2 == 0 ? "" : "idea \(segment)")
        }
        XCTAssertTrue(text.text.hasPrefix("idea 1 idea 3"))
        XCTAssertTrue(text.text.hasSuffix("idea 79"))
    }
}
