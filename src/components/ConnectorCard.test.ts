import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConnectorCardData } from "@/state/store";
import { CONNECTOR_PREVIEWS, ConnectorCard, ConnectorCardView, type ConnectorCardViewProps } from "./ConnectorCard";

const gmail: ConnectorCardData = {
  slug: "gmail",
  label: "Gmail",
  description: "Pepper needs Gmail so i can draft those 4 replies",
  status: "required",
  resumeKey: "k",
  reason: "so i can draft those 4 replies",
};
const view = (props: ConnectorCardViewProps) => renderToStaticMarkup(createElement(ConnectorCardView, props));

describe("ConnectorCardView", () => {
  it("renders every preview with no store and no network", () => {
    expect(CONNECTOR_PREVIEWS.map((preview) => preview.title)).toEqual([
      "required with reason", "authorizing", "connected with actions", "failed", "whatsapp qr", "reconnect",
    ]);
    for (const { title, ...props } of CONNECTOR_PREVIEWS) expect(view(props), title).toContain(props.connector.label);
  });

  it("the live card renders outside a store provider and draws the view (v3 off by default)", () => {
    const message = { id: "m", role: "assistant", text: "", kind: "connector", connector: { ...gmail, status: "connected", resumed: true } } as never;
    const live = renderToStaticMarkup(createElement(ConnectorCard, { botId: "b", threadId: "t", message }));
    expect(live).toBe(view({ connector: { ...gmail, status: "connected", resumed: true } }));
    expect(live).not.toContain("What I can do now");
  });

  it("v3 off ignores reason, reconnect and actions", () => {
    const states: ConnectorCardData[] = [
      { ...gmail, reconnect: true },
      { ...gmail, status: "connected", resumed: true },
    ];
    for (const connector of states) {
      const off = view({ connector, botName: "Pepper" });
      expect(off).not.toContain("What I can do now");
      expect(off).not.toContain("Reconnect");
      expect(off).not.toContain("signing in again");
    }
    // a plain card draws the same pixels on and off
    const plain: ConnectorCardData = { slug: "slack", label: "Slack", description: "Read channels", status: "required", resumeKey: "s" };
    expect(view({ connector: plain, v3: true })).toBe(view({ connector: plain }));
  });

  it("shows the three actions only once v3 is connected and resumed", () => {
    const actions = ["summarise my unread email", "draft replies to anything urgent", "every morning, brief me on new email"];
    const on = view({ connector: { ...gmail, status: "connected", resumed: true }, v3: true, onAction: () => {} });
    expect(on).toContain("What I can do now");
    for (const action of actions) expect(on).toContain(action);
    for (const connector of [gmail, { ...gmail, status: "connected" as const }, { ...gmail, status: "authorizing" as const }]) {
      expect(view({ connector, v3: true, onAction: () => {} })).not.toContain("What I can do now");
    }
    // without a way to send, the buttons stay inert rather than pretending
    expect(view({ connector: { ...gmail, status: "connected", resumed: true }, v3: true })).toContain("disabled");
  });

  it("composes the reason with the bot name and words a reconnect", () => {
    expect(view({ connector: { ...gmail, description: "Read and send email" }, v3: true, botName: "Pepper" }))
      .toContain("Pepper needs Gmail so i can draft those 4 replies");
    const reconnect = view({ connector: { ...gmail, reason: undefined, reconnect: true, description: "x" }, v3: true });
    expect(reconnect).toContain("Gmail needs signing in again");
    expect(reconnect).toContain("Reconnect");
    expect(reconnect).not.toContain(">Connect<");
  });

  it("draws the whatsapp qr from the native snapshot", () => {
    const { title: _title, ...qr } = CONNECTOR_PREVIEWS.find((preview) => preview.title === "whatsapp qr")!;
    const html = view(qr);
    expect(html).toContain("<svg");
    expect(html).toContain("Linked devices");
  });

  it("draws nothing once dismissed", () => {
    expect(view({ connector: { ...gmail, dismissed: true }, v3: true })).toBe("");
  });
});
