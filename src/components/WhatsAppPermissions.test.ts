import { describe, expect, it } from "vitest";
import { whatsappPermissionGrant } from "./WhatsAppPermissions";

describe("owner-reviewed WhatsApp grants", () => {
  const account = "60111111111@c.us";
  it("pins a grant to the verified account and explicit chats with no automatic widening", () => {
    expect(whatsappPermissionGrant(account, ["60222222222@c.us", "60222222222@c.us", "123456@lid"], true, false))
      .toEqual({ accountId: account, chatIds: ["60222222222@c.us", "123456@lid"], outreach: true, autoDispatch: false });
    expect(whatsappPermissionGrant(account, ["60123456789-1234567890@g.us"], false, false))
      .toMatchObject({ chatIds: ["60123456789-1234567890@g.us"], outreach: false, autoDispatch: false });
  });
  it("refuses an unlinked account, empty scope, self-recipient, malformed chat and oversized scope", () => {
    for (const [id, chats] of [[null, ["123@lid"]], [account, []], [account, [account]], [account, ["all"]], [account, Array.from({length:201},(_,i)=>`${i}@lid`)] ] as [string|null,string[]][]) {
      expect(() => whatsappPermissionGrant(id, chats, true, false)).toThrow();
    }
  });
});
