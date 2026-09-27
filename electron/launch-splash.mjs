// Local, sandboxed decoration. It never owns app startup or session readiness.
export function attachLaunchSplash(win, { WebContentsView, filePath, timeoutMs = 6000 }) {
  let view;
  try { view = new WebContentsView({ webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false,
    partition: "bos-launch-splash",
  } }); } catch { return () => {}; }
  let finished = false;
  let loaded = false;
  let ready = false;
  const resize = () => {
    if (finished || win.isDestroyed()) return;
    const [width, height] = win.getContentSize();
    try { view.setBounds({ x: 0, y: 0, width, height }); } catch { finish(); }
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    win.removeListener("resize", resize);
    win.removeListener("closed", finish);
    win.webContents.removeListener("did-finish-load", onReady);
    win.webContents.removeListener("did-fail-load", onReady);
    view.webContents.removeListener("did-finish-load", onLoaded);
    try { if (!win.isDestroyed()) win.contentView.removeChildView(view); } catch {}
    try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch {}
  };
  const exit = () => {
    if (!finished && loaded && ready) {
      try { void view.webContents.executeJavaScript("window.BosSplash?.exit()").catch(finish); } catch { finish(); }
    }
  };
  const onReady = () => { ready = true; exit(); };
  const onLoaded = () => {
    if (finished || view.webContents.isDestroyed()) return;
    try {
    loaded = true;
    void view.webContents.executeJavaScript(
      "new Promise(resolve => window.addEventListener('bos-splash-done', () => resolve(true), {once:true}))"
    ).then(finish, finish);
    exit();
    } catch { finish(); }
  };

  const timer = setTimeout(finish, timeoutMs);
  timer.unref?.();
  try {
  view.webContents.once("did-finish-load", onLoaded);
  view.setBackgroundColor("#0D0D0D");
  view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  view.webContents.on("will-navigate", (event) => event.preventDefault());
  view.webContents.once("did-fail-load", finish);
  view.webContents.once("render-process-gone", finish);
  win.contentView.addChildView(view);
  resize();
  win.on("resize", resize);
  win.once("closed", finish);
  win.webContents.once("did-finish-load", onReady);
  win.webContents.once("did-fail-load", onReady);
  void view.webContents.loadFile(filePath, { query: { hold: "1" } }).catch(finish);
  } catch { finish(); }
  return finish;
}
