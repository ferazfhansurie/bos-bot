const { contextBridge, ipcRenderer } = require("electron");
const channel = process.argv.find(a => a.startsWith("--owner-channel="))?.slice("--owner-channel=".length);
contextBridge.exposeInMainWorld("ownerEnrollment", { context: () => ipcRenderer.invoke(channel, "context"), request: email => ipcRenderer.invoke(channel, "request", { email }), verify: (email, code) => ipcRenderer.invoke(channel, "verify", { email, code }) });
