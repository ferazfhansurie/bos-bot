import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createControlPlaneClient } from "./control-plane-client.mjs";
const ORIGIN = "https://accounts.openmausbot.com";
/** Separate ephemeral sign-in: never changes the Mac's existing BOS account,
 * provider logins, installation credential, or remote pairing. */
export function signInRemoteOwner({ BrowserWindow, ipcMain, parent, environment, createClient = createControlPlaneClient }) {
  return new Promise((resolve, reject) => {
    const channel = `remote-owner:${randomUUID()}`;
    const url = new URL("./resources/remote-full-owner.html", import.meta.url);
    const win = new BrowserWindow({ width: 500, height: 440, title: "BOS — installation owner sign-in", parent, modal: true, show: false,
      webPreferences: { preload: fileURLToPath(new URL("./remote-full-owner-preload.cjs", import.meta.url)), sandbox: true, contextIsolation: true, nodeIntegration: false,
        partition: `remote-owner-${randomUUID()}`, additionalArguments: [`--owner-channel=${channel}`] } });
    const client = createClient({ baseURL: ORIGIN });
    let complete = false, pending = false;
    const timeout = setTimeout(() => win.close(), 10 * 60_000);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", event => event.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ipcMain.handle(channel, async (event, action, data) => {
      if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== url.href || win.isDestroyed()) throw new Error("Owner window only");
      if (action === "context") return { origin: environment.origin, environmentId: environment.environmentId };
      if (pending || complete) return { error: "A request is already in progress" };
      pending = true;
      try {
        if (action === "request" && typeof data?.email === "string") { await client.requestOTP(data.email); return { sent: true }; }
        if (action === "verify" && typeof data?.email === "string" && typeof data?.code === "string") {
          const account = await client.verifyOTP(data.email, data.code);
          complete = true; resolve({ ...account, close: () => client.signOut(account.accountToken).catch(() => {}) }); win.close(); return { verified: true };
        }
        return { error: "Invalid request" };
      } catch { return { error: "Sign-in failed. Check the code or try again." }; }
      finally { pending = false; }
    });
    win.once("closed", () => { clearTimeout(timeout); ipcMain.removeHandler(channel); if (!complete) reject(new Error("Owner sign-in cancelled")); });
    win.once("ready-to-show", () => win.show());
    win.loadFile(fileURLToPath(url)).catch(() => { if (!win.isDestroyed()) win.close(); });
  });
}
export async function authorizeRemoteFull(accountToken, body) {
  const response = await fetch(`${ORIGIN}/v1/remote-full/authorize`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
    headers: { authorization: `Bearer ${accountToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error("This account is not the verified installation owner, or confirmation expired");
}
