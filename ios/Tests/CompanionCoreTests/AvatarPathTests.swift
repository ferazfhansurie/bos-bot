import XCTest

@testable import CompanionCore

/// The phone fetches app-owned photos with its paired token, so the path is
/// checked before any request: the same three routes the companion sidecar
/// allows (companion/src/routes.ts), and nothing that could walk out of them.
final class AvatarPathTests: XCTestCase {
    func testAcceptsAttachmentRoomAndPersonPhotos() {
        for path in [
            "/api/attachments/a1b2-c3.png",
            "/api/attachments/photo.jpg",
            "/api/groups/room-1/avatars/a1b2-c3.png",
            "/api/groups/g_7/avatars/face.webp",
            "/api/multiplayer/people/home-1%3Aperson%3Aowner/photo",
            "/api/multiplayer/people/home-1:person:owner/photo",
        ] {
            XCTAssertTrue(CompanionClient.validAvatarPath(path), path)
        }
    }

    func testRefusesEverythingElse() {
        for path in [
            "/api/config",
            "/api/attachments/../config",
            "/api/attachments/.png",
            "/api/attachments/a.b.png",
            "/api/attachments/face.svg",
            "/api/groups/room-1/avatars/../../config",
            "/api/groups/room-1/avatars/face.png/raw",
            "/api/groups/../avatars/face.png",
            "/api/groups//avatars/face.png",
            "/api/multiplayer/people/x/photo/raw",
            "/api/multiplayer/people/../photo",
            "/api/multiplayer/people/./photo",
            "/api/multiplayer/people/%2e%2e/photo",
            "/api/multiplayer/people/a%2Fb/photo",
            "/api/multiplayer/people//photo",
            "/api/multiplayer/people/a b/photo",
            "/api/multiplayer/people/\(String(repeating: "a", count: 301))/photo",
            "https://evil.example/api/attachments/a.png",
            "api/attachments/a.png",
        ] {
            XCTAssertFalse(CompanionClient.validAvatarPath(path), path)
        }
    }
}
