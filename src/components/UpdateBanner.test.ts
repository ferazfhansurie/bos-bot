import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdaterState } from "@/lib/updater";

const fixture = vi.hoisted(() => ({ state: { status: "idle" } as UpdaterState }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => fixture.state }));
vi.mock("../lib/brand", () => ({ brand: () => ({ name: "BOS Bot" }) }));
import { UpdateBanner } from "./UpdateBanner";

afterEach(() => vi.unstubAllGlobals());
function render(state: UpdaterState) {
  fixture.state = state;
  vi.stubGlobal("window", { ogb: { updater: {} } });
  return renderToStaticMarkup(createElement(UpdateBanner));
}

describe("UpdateBanner", () => {
  it("cannot restart or retry while macOS is preparing the downloaded bytes", () => {
    const html = render({ status: "preparing", version: "0.2.0", percent: 100 });
    expect(html).toContain("Preparing update…");
    expect(html).toContain("macOS is preparing the update.");
    expect(html).toContain("disabled=\"\"");
    expect(html).not.toContain("Restart to update");
    expect(html).not.toContain("Try again");
    expect(html).not.toContain("Dismiss");
  });

  it("offers restart only after native preparation is complete", () => {
    const html = render({ status: "downloaded", version: "0.2.0" });
    expect(html).toContain("0.2.0 is ready");
    expect(html).toContain("Restart to update");
  });

  it("keeps restart busy and displays the recovery instruction", () => {
    const html = render({ status: "installing", message: "Restart is taking longer than expected. Quit the app completely." });
    expect(html).toContain("Quit the app completely.");
    expect(html).toContain("disabled=\"\"");
    expect(html).not.toContain("Try again");
  });

  it("shows a preparation failure with a recovery action", () => {
    const html = render({ status: "error", message: "Native staging failed" });
    expect(html).toContain("Update failed");
    expect(html).toContain("Native staging failed");
    expect(html).toContain("Try again");
  });

  it.each(["ETIMEDOUT while staging", "native error ".repeat(30)])("preserves restart recovery for a nonretryable error: %s", (message) => {
    const html = render({ status: "error", retryable: false, message });
    expect(html).toContain("Quit and reopen BOS Bot before trying the update again.");
    expect(html).not.toContain("Try again");
    expect(html).toContain("Dismiss");
  });

  it("blocks below the floor only while a qualifying update is on its way", () => {
    for (const status of ["available", "downloading", "preparing", "downloaded", "installing"] as const) {
      expect(render({ status, required: true, minimumVersion: "2.1.3", version: "2.1.3" })).toContain("<dialog");
    }
    expect(render({ status: "checking", required: true, minimumVersion: "2.1.3", automaticUpdates: true })).toBe("");
    expect(render({ status: "installing", required: true, message: "Restart is taking longer than expected." })).not.toContain("<dialog");
    expect(render({ status: "downloaded", required: true, installMode: "handoff", version: "2.1.3" })).not.toContain("<dialog");
  });

  it("a floor with nothing qualifying on the feed is a dismissible card, not a lockout", () => {
    const html = render({ status: "idle", required: true, minimumVersion: "9.9.9", automaticUpdates: true });
    expect(html).not.toContain("<dialog");
    expect(html).toContain("Update required");
    expect(html).toContain("9.9.9 or newer");
    expect(html).toContain("Try again");
    expect(html).toContain("Later");
    expect(html).toContain("https://bosbot.my/get");
  });

  it.each([
    { status: "error", required: true, message: "ENOTFOUND updates.example" },
    { status: "error", required: true, retryable: false, message: "No published update meets the required version. Download the latest installer." },
    { status: "error", required: true, retryable: false, quitHeld: true, message: "Update prepare refused; installation remains held" },
  ] as UpdaterState[])("a required update that fails or is held stays dismissible: $message", (state) => {
    const html = render(state);
    expect(html).not.toContain("<dialog");
    expect(html).toMatch(/Dismiss|Later/);
    expect(html).toContain("https://bosbot.my/get");
  });

  it("preserves system package hand-off without promising restart", () => {
    const html = render({ status: "downloaded", version: "0.2.0", installMode: "handoff" });
    expect(html).toContain("Copy the install command and open a terminal.");
    expect(html).not.toContain("Restart to update");
  });

  it("shows the failure cause as well as the required restart without offering a retry", () => {
    const html = render({ status: "error", retryable: false,
      message: "Not enough disk space to prepare the update. Free some space, then try again. Quit and reopen BOS Bot before trying the update again.",
    });
    expect(html).toContain("Free some space");
    expect(html).toContain("Quit and reopen BOS Bot");
    expect(html).not.toContain("Try again</button>");
  });
});
