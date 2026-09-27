# App Review notes

BOS for iPhone is a companion to the BOS desktop app for macOS
(https://bos.aihlete.com). The iPhone app has no account or login screen. It
pairs with one specific Mac by QR code and talks to that Mac over the local
network or over Tailscale. All bots, conversations and files live on the Mac.

## Demo access

[DEMO HOST + PAIRING INSTRUCTIONS — to fill]

## Reviewing the primary flow

1. Install and start BOS on a Mac.
2. In BOS on the Mac, open the phone pairing screen and start pairing so a QR
   code is shown.
3. On the iPhone, allow local network access when asked, tap **Scan QR Code**,
   scan the code shown on the Mac, check the computer name and address, and
   confirm pairing. If the camera is unavailable, choose the discovered
   computer or enter the address and code shown on the Mac.
4. Open a bot from the list, or create one with the `+` button, and send a
   message. Replies stream in as the bot works.
5. When a bot asks for approval or asks a question, a card appears in the chat
   (and, if notifications are allowed, as a notification and Live Activity).
   Answer it from the phone.
6. Shared rooms (people plus their own bots) appear in the same list and work
   the same way.
7. In Safari, Notes, Photos or Files, open the Share sheet and choose **BOS**.
   The extension shows the paired computer and asks for a bot or room before
   sending the selected link, text, image or document. The main app does not
   need to be open, but the Mac must be awake with BOS running.

## Optional features

- **Voice.** Dictation uses Apple speech recognition, on device where the
  device supports it. Hold-to-talk mode can read replies aloud using an
  ElevenLabs API key the user pastes on the phone; it is stored in the phone's
  Keychain and sent only to ElevenLabs. Without a key, voice replies are
  simply unavailable.
- **Tailscale.** To reach the Mac from another network, both devices may be
  signed into the same Tailscale network and the Mac's `.ts.net` MagicDNS name
  entered on the phone. Tailscale is a separate product and not required.
- **Cloud desktop.** If the Mac has a cloud computer configured for a bot, the
  phone can open a live view of it after an explicit confirmation. The Mac
  issues a short-lived HTTPS viewer address, shown in an in-app Safari view.
  The phone never receives the provider's API key.

No purchase or subscription is required in the iPhone app. Because each phone
is paired to one person's own Mac and that Mac holds the bot data and
credentials, a shared universal demo account is not used; see Demo access
above.
