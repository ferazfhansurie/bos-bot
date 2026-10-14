import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettingsSection } from "@/state/store";
import { SettingsModal } from "./SettingsModal";

// #950: a packaged desktop build never surfaced a way to mint a session
// pairing code, so MCP clients (and a second desktop app) had no path to
// one. ServerPairingCard was gated on `!window.ogb`, hiding it from every
// desktop instance instead of only the ones that don't own the server
// being paired against. MOCA-84 then found the remote-client case needs it
// too. 1.9.9 keeps one way to connect a device: the desktop app pairs through
// its companion flow, and the session-code card moved to the desktop's
// server page (Server menu). These tests pin where each path is offered; the
// server still decides who may act.
const fixture = vi.hoisted(() => ({ section: "companion" as AppSettingsSection }));

vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: vi.fn(),
  useStore: () => ({ state: { appSettingsSection: fixture.section }, dispatch: vi.fn() }),
}));
vi.mock("./RemoteComputerSection", () => ({ RemoteComputerSection: () => "REMOTE_CLIENT_MARKER" }));
vi.mock("./LinkedServersCard", () => ({ LinkedServersCard: () => null }));
vi.mock("./ConnectedWorkspacesSettings", () => ({ ConnectedWorkspacesSettings: () => null }));
vi.mock("./CompanionSection", () => ({ CompanionSection: () => "COMPANION_MARKER" }));
vi.mock("./ServerPairingCard", () => ({ ServerPairingCard: () => "SERVER_PAIRING_CARD_MARKER" }));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.section = "companion";
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const render = () => renderToStaticMarkup(createElement(SettingsModal));

describe("Settings → Connect a device: server pairing card visibility", () => {
  it("is offered on a hosted server reached from a browser (no window.ogb)", () => {
    vi.stubGlobal("window", {});
    const html = render();
    expect(html).toContain("SERVER_PAIRING_CARD_MARKER");
    // no desktop bridge, so no "requires the installed app" placeholder
    expect(html).not.toContain("REMOTE_CLIENT_MARKER");
  });

  it("leaves the desktop app with one way to connect, and keeps session codes on its server page", () => {
    vi.stubGlobal("window", { ogb: { environments: {} } });
    const connect = render();
    expect(connect).toContain("COMPANION_MARKER");
    expect(connect).not.toContain("SERVER_PAIRING_CARD_MARKER");
    expect(connect).not.toContain("REMOTE_CLIENT_MARKER");
    fixture.section = "desktopWorkspaces";
    const server = render();
    expect(server).toContain("SERVER_PAIRING_CARD_MARKER");
    // using this desktop as a client of another BOS lives with the servers too
    expect(server).toContain("REMOTE_CLIENT_MARKER");
  });

  it("is offered when this desktop is a remote client of a hosted workspace, whose phones pair only here", () => {
    // MOCA-84: a NAS-hosted server reached from the Mac app had no pairing
    // options at all — the companion section is hidden remotely too. The
    // desktop's requests carry the hosted server's session, so the server,
    // not this gate, decides whether that session may mint codes.
    vi.stubGlobal("window", { ogb: { remoteClient: { active: true } } });
    const html = render();
    expect(html).toContain("SERVER_PAIRING_CARD_MARKER");
    // and the connected card is how it disconnects
    expect(html).toContain("REMOTE_CLIENT_MARKER");
  });
});
