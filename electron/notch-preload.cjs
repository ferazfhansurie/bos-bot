// The notch page's whole bridge (electron/notch.mjs). It draws what the main
// window sends and reports what the person did; it reaches nothing else.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

// geometry and the snapshot can land before the page has subscribed (the
// main process sends them on load, react subscribes a beat later), so the
// latest of each is kept here and handed to a late subscriber
const latest = new Map();
for (const channel of ["notch:geometry", "notch:snapshot"]) {
  ipcRenderer.on(channel, (_event, value) => latest.set(channel, value));
}

ipcRenderer.send("notch:hello");

const listen = (channel) => (cb) => {
  const handler = (_event, value) => cb(value);
  ipcRenderer.on(channel, handler);
  if (latest.has(channel)) cb(latest.get(channel));
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld("notch", {
  onGeometry: listen("notch:geometry"),
  onSnapshot: listen("notch:snapshot"),
  onPointer: listen("notch:pointer"),
  /** true: the shape takes the pointer; false: clicks fall through;
   * "keys": also take the keyboard, for typing an answer. */
  setInteractive: (on) => ipcRenderer.send("notch:interactive", on === "keys" ? "keys" : on === true),
  /** The drawn shape's current size, so the native sensor matches it. */
  setShape: (width, height) => ipcRenderer.send("notch:shape", { width, height }),
  act: (action) => {
    if (action && action.type !== "drop") ipcRenderer.send("notch:action", action);
  },
  /** Hand dropped files to a bot. The paths are read here, off the File
   * objects the drop delivered, so the page never names a path itself (a
   * File the page makes up has none). Returns how many files had one. */
  drop: (botId, threadId, files) => {
    const list = Array.from(files ?? []).slice(0, 20).flatMap((file) => {
      try {
        const filePath = webUtils.getPathForFile(file);
        return filePath ? [{ name: file.name, path: filePath }] : [];
      } catch {
        return [];
      }
    });
    if (list.length) ipcRenderer.send("notch:drop", { botId, threadId, files: list });
    return list.length;
  },
});
