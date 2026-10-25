// The notch's eyes on the hardware: a background helper for electron/notch.mjs.
// Electron can't see the camera housing, so this reports where it is, and it
// keeps one invisible panel over the notch's current shape so a pointer or a
// dragged file arriving there is noticed. An Electron window that lets clicks
// through is blind to both, and polling the cursor would cost cpu all day.
//
// stdout, one JSON object per line:
//   {"type":"screens","screens":[…]}   at start, whenever screens change, and
//                                      when a space or the front app changes
//                                      (each screen says if an app is full
//                                      screen on it)
//   {"type":"hover","phase":"enter"|"exit"}
//   {"type":"drag","phase":"enter"|"exit"}
// stdin, one JSON object per line:
//   {"type":"sensor","screen":<id>,"x":<pt from screen left>,"width":<pt>,"height":<pt>}
//   {"type":"sensor","screen":null}    hides the sensor
// Exits when stdin closes, so it never outlives the app.
import AppKit

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object),
    let line = String(data: data, encoding: .utf8)
  else { return }
  FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

func screenId(_ screen: NSScreen) -> UInt32 {
  (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
}

// The frames of the front app's ordinary windows on screen, in Quartz
// coordinates (top left of the main display). Only the front app: a
// full-screen app is in front in its space, and other apps leave clear
// screen-sized overlays about. Bounds and layer need no screen-recording grant.
func onScreenWindowFrames() -> [CGRect] {
  guard let front = NSWorkspace.shared.frontmostApplication?.processIdentifier,
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
  else { return [] }
  return list.compactMap { info in
    guard (info[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
      (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == front,
      let bounds = info[kCGWindowBounds as String] as? NSDictionary,
      let rect = CGRect(dictionaryRepresentation: bounds)
    else { return nil }
    return rect
  }
}

// A full-screen app's window covers the whole display, menu bar strip and all.
func fullscreen(_ screen: NSScreen, _ windows: [CGRect]) -> Bool {
  guard let main = NSScreen.screens.first else { return false }
  let frame = screen.frame
  let quartz = CGRect(x: frame.minX, y: main.frame.maxY - frame.maxY, width: frame.width, height: frame.height)
  return windows.contains { abs($0.minX - quartz.minX) < 1 && abs($0.minY - quartz.minY) < 1 && abs($0.width - quartz.width) < 1 && abs($0.height - quartz.height) < 1 }
}

func describe(_ screen: NSScreen, _ windows: [CGRect]) -> [String: Any] {
  let frame = screen.frame
  let visible = screen.visibleFrame
  let id = screenId(screen)
  var entry: [String: Any] = [
    "id": id,
    "name": screen.localizedName,
    "builtin": CGDisplayIsBuiltin(id) != 0,
    "frame": ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height],
    // the menu bar is the strip above the visible frame; 0 when it auto-hides
    "menuBar": max(0, frame.maxY - visible.maxY),
    "scale": screen.backingScaleFactor,
    "fullscreen": fullscreen(screen, windows),
  ]
  // macOS 12+: the two strips either side of the camera housing. What lies
  // between them is the notch, as tall as the top safe-area inset.
  if let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
    let x = left.maxX - frame.minX
    let width = right.minX - left.maxX
    let height = screen.safeAreaInsets.top
    if width > 0 && height > 0 { entry["notch"] = ["x": x, "width": width, "height": height] }
  }
  return entry
}

var lastReport = ""
func reportScreens() {
  let windows = onScreenWindowFrames()
  guard let data = try? JSONSerialization.data(withJSONObject: ["type": "screens", "screens": NSScreen.screens.map { describe($0, windows) }], options: [.sortedKeys]),
    let line = String(data: data, encoding: .utf8), line != lastReport
  else { return }
  lastReport = line
  FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

// A space swipe animates for a moment; read the windows once it has landed.
var pendingReport: DispatchWorkItem?
func reportSoon() {
  pendingReport?.cancel()
  let work = DispatchWorkItem { reportScreens() }
  pendingReport = work
  DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: work)
}

final class SensorView: NSView {
  override init(frame: NSRect) {
    super.init(frame: frame)
    registerForDraggedTypes([.fileURL])
  }
  required init?(coder: NSCoder) { nil }
  // A tracking area wakes nothing until the pointer crosses its edge.
  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for area in trackingAreas { removeTrackingArea(area) }
    addTrackingArea(
      NSTrackingArea(
        rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
  }
  override func mouseEntered(with event: NSEvent) { emit(["type": "hover", "phase": "enter"]) }
  override func mouseExited(with event: NSEvent) { emit(["type": "hover", "phase": "exit"]) }
  // Only notice: the drop itself lands on the Electron window, which takes the
  // mouse the moment it hears "enter".
  override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
    emit(["type": "drag", "phase": "enter"])
    return .copy
  }
  override func draggingExited(_ sender: NSDraggingInfo?) { emit(["type": "drag", "phase": "exit"]) }
  override func performDragOperation(_ sender: NSDraggingInfo) -> Bool { false }
}

let panel = NSPanel(
  contentRect: NSRect(x: 0, y: 0, width: 1, height: 1),
  styleMask: [.borderless, .nonactivatingPanel],
  backing: .buffered,
  defer: true)
panel.isOpaque = false
panel.backgroundColor = .clear
panel.hasShadow = false
panel.isReleasedWhenClosed = false
panel.hidesOnDeactivate = false
panel.becomesKeyOnlyIfNeeded = true
// above the menu bar, below the Electron notch window (screen-saver level)
panel.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.mainMenuWindow)) + 2)
panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
panel.contentView = SensorView(frame: NSRect(x: 0, y: 0, width: 1, height: 1))

func placeSensor(_ command: [String: Any]) {
  guard let id = (command["screen"] as? NSNumber)?.uint32Value,
    let screen = NSScreen.screens.first(where: { screenId($0) == id }),
    let x = (command["x"] as? NSNumber)?.doubleValue,
    let width = (command["width"] as? NSNumber)?.doubleValue,
    let height = (command["height"] as? NSNumber)?.doubleValue,
    width >= 1, height >= 1
  else {
    panel.orderOut(nil)
    return
  }
  let frame = screen.frame
  panel.setFrame(
    NSRect(x: frame.minX + x, y: frame.maxY - height, width: width, height: height), display: false)
  panel.orderFrontRegardless()
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

NotificationCenter.default.addObserver(
  forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
) { _ in reportScreens() }
// entering or leaving full screen is a space change; so is a swipe between
// spaces, and switching apps can bring a full-screen one forward
for name in [NSWorkspace.activeSpaceDidChangeNotification, NSWorkspace.didActivateApplicationNotification] {
  NSWorkspace.shared.notificationCenter.addObserver(forName: name, object: nil, queue: .main) { _ in reportSoon() }
}

// stdin on a background thread; every command is applied on the main thread
Thread.detachNewThread {
  while let line = readLine() {
    guard let data = line.data(using: .utf8),
      let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      command["type"] as? String == "sensor"
    else { continue }
    DispatchQueue.main.async { placeSensor(command) }
  }
  exit(0)
}

DispatchQueue.main.async { reportScreens() }
app.run()
