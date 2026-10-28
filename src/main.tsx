import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { readSessionState, takePairingCodeFromLocation, takeInvitedEmailFromLocation } from "./lib/session";
import { bootstrapBrand } from "./lib/brand";
import { applyGlass, applySkin, glassOn, readSkin } from "./lib/skins";
import { initV3, v3Enabled } from "./lib/v3";
import { PairPage } from "./pair/PairPage";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { DetachedWorkspace, detachedSpecFromLocation } from "./components/workspace/DetachedWorkspace";
import { PrimaryBrowser } from "./components/PrimaryBrowser";
import "./styles.css";

// Before the first paint, not inside a component: stamping the skin during
// render would show one frame of the default palette first. The brand (window
// title, accent) is fetched the same way so a white-labelled deployment never
// flashes the default name; it waits at most a moment and falls back silently.
initV3();
applySkin(readSkin(v3Enabled()));
applyGlass(v3Enabled() && glassOn());

/** A pairing link lands on /pair. A remote browser without a session lands
 * there too, because every API call would otherwise fail with "pair this
 * device"; on the owner's own machine the server trusts loopback and this
 * check is a single fast request. */
async function chooseRoot(): Promise<React.ReactNode> {
  if (location.pathname === "/pair") return <PairPage initialCode={takePairingCodeFromLocation()} initialEmail={takeInvitedEmailFromLocation()} />;
  const session = await readSessionState();
  if (session.kind === "unauthenticated") return <PairPage initialCode={null} reason={session.error} />;
  // the window a paired workspace's bots drive on this computer: just the browser
  if (window.ogb?.primaryBrowser && new URLSearchParams(location.search).has("bos-browser-window")) {
    const noop = () => {};
    return <div className="h-screen w-screen"><PrimaryBrowser visible expanded onExpand={noop} target={{ botId: "", threadId: "", name: "" }} onTool={noop} onClose={() => window.close()} /></div>;
  }
  // a workspace tab moved into its own window draws only that tab
  const detached = window.ogb?.workspaceWindow ? detachedSpecFromLocation(location.search) : null;
  if (detached) return <DetachedWorkspace spec={detached} />;
  return <App />;
}

void Promise.all([bootstrapBrand(), chooseRoot()]).then(([, root]) => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <AppErrorBoundary>{root}</AppErrorBoundary>
    </StrictMode>,
  );
});
