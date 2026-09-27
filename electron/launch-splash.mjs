// Local, sandboxed decoration. It never owns app startup or session readiness.
export function attachLaunchSplash(win, { WebContentsView, filePath, timeoutMs = 6000 }) {
  const view = new WebContentsView({ webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false,
    partition: "bos-launch-splash",
  } });
  let finished = false;
  let loaded = false;
  let ready = false;
  const resize = () => {
    if (finished || win.isDestroyed()) return;
    const [width, height] = win.getContentSize();
    view.setBounds({ x: 0, y: 0, width, height });
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    win.removeListener("resize", resize);
    win.removeListener("closed", finish);
    win.webContents.removeListener("did-finish-load", onReady);
    win.webContents.removeListener("did-fail-load", onReady);
    if (!win.isDestroyed()) win.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  };
  const exit = () => {
    if (!finished && loaded && ready) {
      void view.webContents.executeJavaScript("window.BosSplash?.exit()").catch(finish);
    }
  };
  const onReady = () => { ready = true; exit(); };
  const timer = setTimeout(finish, timeoutMs);
  timer.unref?.();
  view.setBackgroundColor("#0D0D0D");
  view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  view.webContents.on("will-navigate", (event) => event.preventDefault());
  view.webContents.once("did-fail-load", finish);
  view.webContents.once("render-process-gone", finish);
  view.webContents.once("did-finish-load", () => {
    loaded = true;
    void view.webContents.executeJavaScript(
      "new Promise(resolve => window.addEventListener('bos-splash-done', () => resolve(true), {once:true}))"
    ).then(finish, finish);
    exit();
  });
  win.contentView.addChildView(view);
  resize();
  win.on("resize", resize);
  win.once("closed", finish);
  win.webContents.once("did-finish-load", onReady);
  win.webContents.once("did-fail-load", onReady);
  void view.webContents.loadFile(filePath, { query: { hold: "1" } }).catch(finish);
  return finish;
}
