# chatgpt conversation rendering

scope: native ios chat rows and media. the shared desktop specification is at
kept outside this repository.

## preview without live data

build the debug app for the existing simulator named `bos`, then launch with:

```
-store-preview -chatgpt-preview -open-chat preview-bos
```

`ChatGPTPreviewProtocol` serves bundled media through the existing authenticated
message file request; every other request on that session fails locally. it
uses a synthetic token and never pairs with a real computer. `room-launch`
previews two bot identities in a room. `-scroll-to <message id>` parks the
transcript; `-expand-worked` expands the work disclosure; `-open-lightbox a3`
opens the image viewer. these hooks are debug-only.

## checks

```
cd ios
swift test
xcodegen generate
xcodebuild -project BosBot.xcodeproj -scheme BosBot \
  -destination 'platform=iOS Simulator,name=bos' \
  -parallel-testing-enabled NO \
  -only-testing:BosBotUITests/ChatGPTConversationUITests \
  CODE_SIGNING_ALLOWED=NO test
```

use a worktree-specific derived-data path. never create another simulator.
the ui checks expand/collapse work, copy code, open changed-file details, page
and close images, play video, play/pause audio and open pdf/docx/xlsx previews
in dark and light themes. screenshots are retained as xcresult attachments.

## native adaptations and boundaries

- prose and code default to the specified 14pt and 12pt, with dynamic type.
- bot face/name leads each reply stretch, including rooms.
- a phone gallery has two visible square slots instead of four desktop slots;
  horizontal paging and the full-screen image pager expose the remainder.
- sf symbols replace reference icons. syntax colouring is native swift code.
- documents use the existing quick look/pdf preview and native share sheet.
- video uses avplayer and audio plays locally, with pending work cancelled when
  the row disappears. temporary previews retain cleanup ownership.
- latest-reply actions stay visible on touch. older-message actions remain in
  the existing context menu.
- the file card exposes captured tool inputs through view changes. there is no
  undo/reapply button because the companion exposes no guarded undo endpoint;
  a phone must not simulate a successful repository mutation.
- the existing header, composer, steering/queue controls, approvals, outbound
  review, questions, voice memos, meeting recording and resume paths remain.
- no proprietary font, openai implementation, device install or release here.
