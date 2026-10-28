import { describe, expect, it } from "vitest";
import type { ConnectorCardData } from "../shared/wire.ts";
import { connectReason, connectorCardDescription, openReconnectCard } from "./connector-cards.ts";

describe("connectReason", () => {
  it("keeps one clean line that reads after '<bot> needs <app>'", () => {
    expect(connectReason("  so i can draft\n those 4 replies. ")).toBe("so i can draft those 4 replies");
    expect(connectReason("So I can read your inbox")).toBe("so I can read your inbox");
    expect(connectReason("API access for the report")).toBe("API access for the report");
    expect(connectReason("x".repeat(400))!.length).toBe(140);
  });
  it("drops anything that is not text", () => {
    for (const value of [undefined, null, 4, "", "  \n ", "..."]) expect(connectReason(value)).toBeUndefined();
  });
});

describe("connectorCardDescription", () => {
  it("prefers reconnect, then alias, then reason, then the toolkit blurb", () => {
    expect(connectorCardDescription({ label: "Gmail", reconnect: true, reason: "x" })).toBe("Gmail needs signing in again");
    expect(connectorCardDescription({ label: "Gmail", alias: "work", reason: "x" })).toBe("Connect Gmail as “work” so the bot can continue");
    expect(connectorCardDescription({ label: "Gmail", botName: "Pepper", reason: "so i can draft those 4 replies" })).toBe("Pepper needs Gmail so i can draft those 4 replies");
    expect(connectorCardDescription({ label: "Gmail", reason: "to read mail" })).toBe("Your bot needs Gmail to read mail");
    expect(connectorCardDescription({ label: "Gmail", blurb: "Read and send email" })).toBe("Read and send email");
    expect(connectorCardDescription({ label: "Gmail" })).toBe("Connect Gmail so the bot can continue");
  });
});

describe("openReconnectCard", () => {
  const card = (id: string, connector: Partial<ConnectorCardData>) => ({
    id,
    kind: "connector",
    connector: { slug: "gmail", label: "Gmail", description: "", status: "required", resumeKey: `key-${id}`, reconnect: true, ...connector } as ConnectorCardData,
  });
  it("finds an unresolved reconnect card for the same app", () => {
    expect(openReconnectCard([card("a", {}), card("b", { slug: "slack" })], "gmail")?.id).toBe("a");
    expect(openReconnectCard([card("a", { status: "authorizing" })], "gmail")?.id).toBe("a");
    expect(openReconnectCard([card("a", { status: "failed" })], "gmail")?.id).toBe("a");
  });
  it("lets a new card through once the old one is resolved, or for a plain connect card", () => {
    expect(openReconnectCard([card("a", { status: "connected" })], "gmail")).toBeUndefined();
    expect(openReconnectCard([card("a", { dismissed: true })], "gmail")).toBeUndefined();
    expect(openReconnectCard([card("a", { reconnect: undefined })], "gmail")).toBeUndefined();
    expect(openReconnectCard([{ id: "t", kind: "text" }], "gmail")).toBeUndefined();
  });
});
