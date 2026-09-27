# TestFlight and App Store release

The app is native Swift and uses XcodeGen; EAS commands do not apply.

## App identity

- Name: **BOS**, display name `BOS`, version `1.0.0`
- Bundle IDs: `com.aihlete.aios` (app), `com.aihlete.aios.share`,
  `com.aihlete.aios.widgets`, `com.aihlete.aios.notification-service`
- App Group: `group.com.aihlete.aios.shared`
- Primary category: **Productivity**

## One-time Apple setup

1. Register the four bundle IDs above in the Apple Developer account.
2. Register the App Group `group.com.aihlete.aios.shared`. Enable App Groups
   for the app, Share extension, widgets and Notification Service extension,
   and Keychain Sharing for the app and Share extension.
3. Enable Push Notifications and Communication Notifications for the app.
4. Create the app in App Store Connect with the name **BOS**, category
   **Productivity**, and a unique SKU.
5. Create Apple Distribution certificates and App Store provisioning profiles
   for the app and all three extensions.
6. Add the review contact in App Store Connect; do not commit private contact
   data or App Store Connect keys.

## Before every upload

1. Run `swift test` from the repository root.
2. Generate the Xcode project with `xcodegen generate`.
3. Confirm `DEVELOPMENT_TEAM` for the Release configuration.
4. Increment `CURRENT_PROJECT_VERSION` for every upload. Change
   `MARKETING_VERSION` only for a new App Store version.
5. Check push for production: `project.yml` sets `aps-environment:
   development`, and `Session.registerPushToken` sends
   `environment: "development"` to the Mac. A distribution build receives
   production APNs tokens, so both need to be production (or derived from the
   build) for notifications to arrive.
6. Archive a generic iOS device build and validate it in Xcode Organizer.
7. Upload to App Store Connect and distribute to internal TestFlight testers.
8. Real-iPhone pass: QR pairing, local network permission, Keychain restore,
   Tailscale, approvals, secure credential entry, notifications, background
   and foreground reconciliation, sign-out/revocation, shared rooms, and
   Share-sheet delivery of text, a link, an image and a document (repeat after
   force-quitting the app).
9. After internal testing, submit to an external TestFlight group before
   App Review.

## App Store Connect

- Copy the localized text from `en-US/`.
- Use `privacy-answers.md` and confirm it still matches the binary and the
  desktop's services.
- Use `review-notes.md`, filling in the demo access section and a real review
  contact.
- Support URL: `https://bos.aihlete.com/support`
- Privacy policy URL: `https://bos.aihlete.com/privacy`
- Both pages must be live before submission.
- Choose manual release for 1.0; enable phased release once the first
  production build is stable.
