import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createControlPlaneClient } from "./control-plane-client.mjs";
import { controlPlaneUnavailableReason, resolveCompanionControlPlaneURL } from "./companion-account-service.mjs";
/** The owner authority is the configured control plane (BOS_CONTROL_PLANE_URL
 * or legacy OMB_CONTROL_PLANE_URL). No hosted default: unset disables remote
 * owner sign-in and nothing is fetched. */
export function remoteOwnerAuthorityOrigin(environment = process.env) {
  return resolveCompanionControlPlaneURL({ environment });
}
/** Separate ephemeral sign-in: never changes the Mac's existing BOS account,
 * provider logins, installation credential, or remote pairing. */
export function signInRemoteOwner({ BrowserWindow, ipcMain, parent, environment, createClient = createControlPlaneClient, timers = { setTimeout, clearTimeout }, authorityOrigin = remoteOwnerAuthorityOrigin() }) {
  if (!authorityOrigin) return Promise.reject(new Error(controlPlaneUnavailableReason()));
  return new Promise((resolve, reject) => {
    const channel = `remote-owner:${randomUUID()}`;
    const url = new URL("./resources/remote-full-owner.html", import.meta.url);
    const win = new BrowserWindow({ width: 500, height: 440, title: "BOS — installation owner sign-in", parent, modal: true, show: false,
      webPreferences: { preload: fileURLToPath(new URL("./remote-full-owner-preload.cjs", import.meta.url)), sandbox: true, contextIsolation: true, nodeIntegration: false,
        partition: `remote-owner-${randomUUID()}`, additionalArguments: [`--owner-channel=${channel}`] } });
    const client = createClient({ baseURL: authorityOrigin });
    const contents = win.webContents;
    let state = "active", generation = 0, pending = false, cleaned = false;
    const alive = () => !win.isDestroyed() && !contents.isDestroyed();
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      timers.clearTimeout(timeout);
      ipcMain.removeHandler(channel);
      win.removeListener("close", closing);
      win.removeListener("closed", cancel);
      win.removeListener("ready-to-show", show);
      contents.removeListener("destroyed", cancel);
    };
    const dismiss = () => {
      if (win.isDestroyed()) return;
      try { win.close(); } catch { /* Destruction can race the native close. */ }
    };
    const cancel = (dismissWindow = true) => {
      if (state !== "active") return;
      state = "cancelled"; generation++;
      cleanup();
      reject(new Error("Owner sign-in cancelled"));
      if (dismissWindow) dismiss();
    };
    const closing = () => cancel(false);
    const show = () => { if (state === "active" && alive()) win.show(); };
    const timeout = timers.setTimeout(cancel, 10 * 60_000);
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", event => event.preventDefault());
    contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ipcMain.handle(channel, async (event, action, data) => {
      // Check lifecycle before accessing native frame properties: those may
      // throw once Chromium destroys the window while a request is pending.
      if (state !== "active" || !alive() || event.sender !== contents || event.senderFrame !== contents.mainFrame || event.senderFrame.url !== url.href) throw new Error("Owner window only");
      if (action === "context") return { origin: environment.origin, environmentId: environment.environmentId };
      if (pending) return { error: "A request is already in progress" };
      pending = true;
      const requestGeneration = generation;
      const current = () => state === "active" && requestGeneration === generation && alive();
      try {
        if (action === "request" && typeof data?.email === "string") {
          await client.requestOTP(data.email);
          if (!current()) { cancel(); return { cancelled: true }; }
          return { sent: true };
        }
        if (action === "verify" && typeof data?.email === "string" && typeof data?.code === "string") {
          const account = await client.verifyOTP(data.email, data.code);
          // A cancelled request can still create an account session remotely.
          // Dispose that late result, never resolve it to the grant controller.
          // The successful controller also receives this idempotent disposer.
          let disposal;
          const closeAccount = () => disposal ??= Promise.resolve()
            .then(() => client.signOut(account.accountToken)).catch(() => {});
          if (!current()) {
            cancel();
            await closeAccount();
            return { cancelled: true };
          }
          state = "succeeded"; generation++;
          cleanup(); dismiss();
          resolve({ ...account, close: closeAccount });
          return { verified: true };
        }
        return { error: "Invalid request" };
      } catch {
        if (!current()) { cancel(); return { cancelled: true }; }
        return { error: "Sign-in failed. Check the code or try again." };
      } finally { if (requestGeneration === generation) pending = false; }
    });
    win.once("close", closing);
    win.once("closed", cancel);
    contents.once("destroyed", cancel);
    win.once("ready-to-show", show);
    win.loadFile(fileURLToPath(url)).catch(cancel);
  });
}
export async function authorizeRemoteFull(accountToken, body, { authorityOrigin = remoteOwnerAuthorityOrigin(), fetchImpl = fetch } = {}) {
  if (!authorityOrigin) throw new Error(controlPlaneUnavailableReason());
  const response = await fetchImpl(`${authorityOrigin}/v1/remote-full/authorize`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
    headers: { authorization: `Bearer ${accountToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error("This account is not the verified installation owner, or confirmation expired");
}
