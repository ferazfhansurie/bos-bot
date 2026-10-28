import { describe, expect, it } from "vitest";
import { whatsappAccessChoice, whatsappAccessSummary, whatsappChatLabel, whatsappPermissionGrant, type WhatsAppAccessChoice } from "./WhatsAppPermissions";

const choice = (patch: Partial<WhatsAppAccessChoice>): WhatsAppAccessChoice => ({ reading: "chosen", replying: true, chatIds: [], outreach: false, autoDispatch: false, ...patch });

describe("owner-reviewed WhatsApp grants", () => {
  const account = "60111111111@c.us";
  it("pins a reply grant to the verified account and explicit chats with no automatic widening", () => {
    expect(whatsappPermissionGrant(account, choice({ chatIds: ["60222222222@c.us", "60222222222@c.us", "123456@lid"], outreach: true })))
      .toEqual({ accountId: account, chatIds: ["60222222222@c.us", "123456@lid"], outreach: true, autoDispatch: false, draft: false });
    expect(whatsappPermissionGrant(account, choice({ chatIds: ["60123456789-1234567890@g.us"] })))
      .toMatchObject({ chatIds: ["60123456789-1234567890@g.us"], outreach: false, autoDispatch: false });
  });
  it("reading all with replies off is read-only whatever was ticked", () => {
    expect(whatsappPermissionGrant(account, choice({ reading: "all", replying: false, chatIds: ["123456@lid"], outreach: true, autoDispatch: true })))
      .toEqual({ accountId: account, chatIds: [], outreach: false, autoDispatch: false, readAll: true });
    expect(whatsappPermissionGrant(account, choice({ reading: "all", chatIds: ["123456@lid"], autoDispatch: true })))
      .toEqual({ accountId: account, chatIds: ["123456@lid"], outreach: false, autoDispatch: true, draft: false, readAll: true });
    expect(whatsappPermissionGrant(account, choice({ chatIds: ["123456@lid"], autoDispatch: true, draft: true }))).toMatchObject({ autoDispatch: true, draft: true });
    expect(whatsappPermissionGrant(account, choice({ chatIds: ["123456@lid"], autoDispatch: false, draft: true }))).toMatchObject({ autoDispatch: false, draft: false });
  });
  it("chosen chats with replies off reads only those chats and can never send", () => {
    expect(whatsappPermissionGrant(account, choice({ replying: false, chatIds: ["123456@lid"], outreach: true, autoDispatch: true })))
      .toEqual({ accountId: account, chatIds: ["123456@lid"], outreach: false, autoDispatch: false, readOnly: true });
  });
  it("off revokes everything", () => {
    expect(whatsappPermissionGrant(account, choice({ reading: "off", chatIds: ["123456@lid"], outreach: true })))
      .toEqual({ accountId: account, chatIds: [], outreach: false, autoDispatch: false, readAll: false });
  });
  it("refuses an unlinked account, empty scope, self-recipient, malformed chat and oversized scope", () => {
    for (const [id, chats] of [[null, ["123456@lid"]], [account, []], [account, [account]], [account, ["all"]], [account, Array.from({ length: 201 }, (_, i) => `${100000 + i}@lid`)]] as [string | null, string[]][]) {
      expect(() => whatsappPermissionGrant(id, choice({ chatIds: chats }))).toThrow();
    }
    expect(() => whatsappPermissionGrant(null, choice({ reading: "all", replying: false }))).toThrow();
    expect(() => whatsappPermissionGrant(account, choice({ replying: false }))).toThrow();
  });
});

describe("reading a saved policy back into the controls", () => {
  const accountId = "60111111111@c.us";
  it("maps every saved shape to what the controls show", () => {
    expect(whatsappAccessChoice(null)).toMatchObject({ reading: "all", replying: false });
    expect(whatsappAccessChoice({ accountId, chatIds: [], autoDispatch: false, readAll: true })).toMatchObject({ reading: "all", replying: false });
    expect(whatsappAccessChoice({ accountId, chatIds: ["123456@lid"], autoDispatch: true, readAll: true })).toMatchObject({ reading: "all", replying: true, autoDispatch: true });
    expect(whatsappAccessChoice({ accountId, chatIds: ["123456@lid"], autoDispatch: false, readOnly: true })).toMatchObject({ reading: "chosen", replying: false });
    expect(whatsappAccessChoice({ accountId, chatIds: ["123456@lid"], autoDispatch: false })).toMatchObject({ reading: "chosen", replying: true });
    expect(whatsappAccessChoice({ accountId, chatIds: [], autoDispatch: false })).toMatchObject({ reading: "off", replying: false });
    expect(whatsappAccessChoice({ accountId, chatIds: null, autoDispatch: true })).toMatchObject({ reading: "all", replying: true });
    expect(whatsappAccessChoice({ accountId, chatIds: ["123456@lid"], autoDispatch: true, draft: true })).toMatchObject({ autoDispatch: true, draft: true });
  });
  it("round-trips every grant", () => {
    for (const c of [choice({ reading: "all", replying: false }), choice({ replying: false, chatIds: ["123456@lid"] }), choice({ chatIds: ["123456@lid"], outreach: true }), choice({ reading: "all", chatIds: ["123456@lid"], autoDispatch: true })]) {
      const back = whatsappAccessChoice(whatsappPermissionGrant(accountId, c));
      expect(back.reading).toBe(c.reading);
      expect(back.replying).toBe(c.replying);
    }
  });
});

describe("plain labels", () => {
  it("never shows a raw id as a chat name", () => {
    expect(whatsappChatLabel({ id: "60123456789@c.us", name: null })).toBe("+60 12-345 6789");
    expect(whatsappChatLabel({ id: "4412345678@c.us", name: null })).toBe("+4412345678");
    expect(whatsappChatLabel({ id: "219920001234567@lid", name: null })).toBe("Unknown contact");
    expect(whatsappChatLabel({ id: "120363000000000000@g.us", name: null, group: true })).toBe("Unnamed group");
    expect(whatsappChatLabel({ id: "120363000000000000@g.us", name: "Ops team", group: true })).toBe("Ops team");
  });
  it("summarises the exact access", () => {
    expect(whatsappAccessSummary("bos", choice({ reading: "all", replying: false }), 89)).toBe("bos can read all your chats (89 so far), including new ones. Replies are off.");
    expect(whatsappAccessSummary("bos", choice({ replying: false, chatIds: ["123456@lid"] }), 89)).toBe("bos can read 1 chat. Replies are off.");
    expect(whatsappAccessSummary("bos", choice({ reading: "off" }), 89)).toBe("bos can't read or reply in WhatsApp.");
  });
});
