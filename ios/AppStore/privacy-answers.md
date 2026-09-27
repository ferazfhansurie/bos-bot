# App Privacy answers

Checked against the iOS source in this repository (app, Share extension,
Notification Service extension, widgets, CompanionCore) on 2026-09-26.
Re-check before every upload, and re-check against the BOS desktop app,
because much of the data flow depends on what the desktop does.

## What the binary contains

- No third-party SDKs. No analytics, crash reporting, advertising or
  attribution code. The Swift package has no external dependencies.
- `PrivacyInfo.xcprivacy` (app and Share extension) declares no tracking, no
  tracking domains and no collected data types. Required-reason APIs:
  UserDefaults (CA92.1, 1C8F.1), file timestamps (C617.1; plus 3B52.1 in the
  extension), system boot time (35F9.1, extension).
- No email sign-in or account screen on the phone. The app decodes a profile
  name and email from the paired Mac's config response, but does not display,
  store or send them anywhere.
- Hosted HTTPS route code is still present: a QR code from the desktop may
  include an `https://` address (endpoint kind `hosted`), and the phone will
  use it. Whether BOS desktop ever issues one, and who operates it, is decided
  by the desktop. If BOS offers no hosted relay, the phone only uses local
  network and Tailscale addresses.

## Where the phone sends data

1. **The paired Mac** (LAN, Tailscale `.ts.net`, or a desktop-issued HTTPS
   address). Messages, approvals, attachments chosen by the user, shared-room
   messages, profile photo, search queries, the phone's device name (at
   pairing) and the APNs push token (`/api/multiplayer/push-token`).
2. **ElevenLabs** (`api.elevenlabs.io`), only if the user pastes their own
   ElevenLabs key for spoken replies. Reply text and the key are sent there;
   the key stays in the phone's Keychain.
3. **Apple**: APNs for notifications; Speech framework for dictation (on
   device where supported, otherwise Apple's servers).
4. **Cloud desktop viewer**: an HTTPS URL issued by the Mac, opened in
   `SFSafariViewController` only after the user confirms.

The developer does not receive any of this data from the iOS app, unless the
developer operates the hosted HTTPS relay or the shared-rooms/push service used
by the desktop. Confirm that before answering.

## App Store Connect answers

- Tracking: **No**
- Third-party advertising or analytics SDKs: **None**
- Data used for advertising or marketing: **None**
- Data collected: **No data collected**, provided the developer operates no
  service in the path (data goes only to the user's own Mac, to Apple, and to
  ElevenLabs under the user's own key).
- If BOS operates a hosted relay, shared-rooms service or push sender that
  sees this traffic, instead declare, for **App Functionality**, not linked to
  tracking: **User Content** (messages, photos/files the user sends), and
  **Identifiers → Device ID** (push token / paired-device ID). Mark as linked
  to the user if that service knows who the user is.

## Credentials entered on the phone

- A secret entered into a pending secure card is encrypted on the phone for
  the paired Mac before sending; only ciphertext leaves the phone. The field
  is cleared after encryption and the value is not written to chat,
  preferences, Keychain or logs.
- The pairing token is kept in the Keychain, shared with the Share extension
  through the `group.com.aihlete.aios.shared` access group.

## Attachments

Images and documents are sent only after the user chooses them and taps
**Send**. The Share extension removes its temporary copy after completion or
cancellation, and an abandoned copy is removed on the next Share-sheet session
or app foreground. A file opened from a bot message is downloaded from the
paired Mac and its temporary preview is removed when closed.

## URLs

- Privacy policy: `https://bos.aihlete.com/privacy` (to be published before
  submission)
- Support: `https://bos.aihlete.com/support` (to be published before
  submission)
