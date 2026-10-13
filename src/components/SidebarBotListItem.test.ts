import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { StoreProvider, type Bot } from "@/state/store";

vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({}),
}));

import { ConfirmDialogCard } from "./ConfirmDialog";
import { BotDeleteMenuItem, BotListItem, botConfirmCopy, currentArchivableBot } from "./Sidebar";

const bot = (overrides: Partial<Bot> = {}): Bot => ({
  id: "atlas",
  threadId: "thread-atlas",
  name: "Atlas",
  title: "",
  description: "",
  notifications: true,
  color: "green",
  unread: false,
  modelSelection: { instanceId: "claude", model: "test" },
  messages: [],
  ...overrides,
});

function renderRow(candidate: Bot) {
  return renderToStaticMarkup(createElement(
    StoreProvider,
    null,
    createElement(BotListItem, {
      bot: candidate,
      density: "comfortable",
      onMenu: vi.fn(),
    }),
  ));
}

describe("BotListItem", () => {
  it("offers a direct New folder button and keyboard-accessible bot menu independently of New thread", () => {
    const markup = renderRow(bot());
    expect(markup).toContain('aria-label="New folder under Atlas"');
    expect(markup).toContain('aria-label="Actions for Atlas"');
    expect(markup).toContain('aria-haspopup="menu"');
  });
  it("keeps unselected bots compact without a thread expansion toggle", () => {
    const markup = renderRow(bot());
    expect(markup).toContain('role="button" tabindex="0"');
    expect(markup).not.toContain('aria-label="Expand Atlas threads"');
    expect(markup).not.toContain('aria-label="Atlas threads"');
  });

  it("previews the last reply, not the digest receipt that follows it", () => {
    const markup = renderRow(bot({
      messages: [
        { id: "u1", role: "user", kind: "text", text: "make notes.txt", at: 1 },
        { id: "b1", role: "bot", kind: "text", text: "Created notes.txt with three lines.", at: 2 },
        { id: "d1", role: "bot", kind: "digest", text: "[digest] · tools: Write ×1", at: 3, digest: { turnId: "t1", tools: [{ name: "Write", count: 1 }], hookCoverage: "full" } },
      ] as Bot["messages"],
    }));
    expect(markup).toContain("Created notes.txt with three lines.");
    expect(markup).not.toContain("[digest]");
  });

  it("leaves the full Chief card as one selectable hit area", () => {
    const markup = renderRow(bot({ chiefOfStaff: true }));

    expect(markup).toContain('data-sidebar-bot-row="atlas"');
    expect(markup).not.toContain('aria-label="Archive Atlas"');
  });

  it("keeps the Chief of Staff label available to screen readers", () => {
    const withTitle = renderRow(bot({ chiefOfStaff: true, title: "Developer" }));
    expect(withTitle).toContain("Chief of Staff</span>");
    // the label sits after the name line, never inside it
    expect(withTitle.indexOf("Chief of Staff</span>")).toBeGreaterThan(withTitle.indexOf(">Atlas<"));

    const withoutTitle = renderRow(bot({ chiefOfStaff: true }));
    expect(withoutTitle).toContain("Chief of Staff</span>");
    expect(withoutTitle.indexOf("Chief of Staff</span>")).toBeGreaterThan(withoutTitle.indexOf(">Atlas<"));

    expect(renderRow(bot())).not.toContain("Chief of Staff");
  });

  it("keeps roles accessible without adding a third visible row", () => {
    const markup = renderRow(bot({ title: "Developer" }));
    expect(markup).toContain('<div class="sr-only">Developer</div>');
    expect(markup).toContain('title="Double-click to rename"');
    expect(renderRow(bot({ title: "  " }))).not.toContain('<div class="sr-only">');
  });

  it("shows typing dots instead of preview text while the bot works", () => {
    const markup = renderRow(bot({ busy: true }));

    expect(markup).toContain("animate-status-pulse");
    expect(markup).toContain('class="sr-only">Working…');
  });

  it("marks the avatar with a green presence dot only while the bot works", () => {
    expect(renderRow(bot({ busy: true }))).toContain('data-testid="working-dot"');
    expect(renderRow(bot())).not.toContain('data-testid="working-dot"');
    expect(renderRow(bot({ busy: true, activity: "waiting-on-you" }))).not.toContain('data-testid="working-dot"');
  });

  it("keeps Archive in the Actions menu and reveals quiet row controls on focus as well as hover", () => {
    const markup = renderRow(bot());
    expect(markup).not.toContain('aria-label="Archive Atlas"');
    expect(markup).toContain('aria-label="Actions for Atlas"');
    expect(markup).toContain("focus:opacity-100");
    expect(markup).toContain("focus:pointer-events-auto");
    expect(markup).not.toContain("pr-[92px]");
  });
});

describe("archive / delete confirmation", () => {
  it("rechecks the latest fleet after a confirmation was opened", () => {
    const snapshot = bot();
    const other = bot({ id: "other" });
    const renamed = bot({ name: "New name" });
    expect(currentArchivableBot([renamed, other], snapshot.id)).toBe(renamed);
    expect(currentArchivableBot([bot({ chiefOfStaff: true }), other], snapshot.id)).toBeUndefined();
    expect(currentArchivableBot([bot({ hidden: true }), other], snapshot.id)).toBeUndefined();
    expect(currentArchivableBot([snapshot], snapshot.id)).toBeUndefined();
    expect(currentArchivableBot([other, bot({ id: "third" })], snapshot.id)).toBeUndefined();
  });
  it("archive copy names the bot and says it can be restored", () => {
    const copy = botConfirmCopy("archive", "Juniper");

    expect(copy.title).toContain("Juniper");
    expect(copy.body).toMatch(/restore/i);
    expect(copy.tone).toBe("neutral");
  });

  it("delete copy names the bot and warns about its owned computer", () => {
    const copy = botConfirmCopy("delete", "Willow");

    expect(copy.title).toContain("Willow");
    expect(copy.body).toMatch(/permanently/i);
    expect(copy.body).toMatch(/any computer it owns/i);
    expect(copy.body).toMatch(/files and browser sign-ins/i);
    expect(copy.body).toMatch(/shared team computers remain/i);
    expect(copy.tone).toBe("danger");
  });

  it("renders as an alert dialog with Cancel and the action button", () => {
    const markup = renderToStaticMarkup(createElement(ConfirmDialogCard, {
      open: true,
      ...botConfirmCopy("delete", "Willow"),
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    }));

    expect(markup).toContain('role="alertdialog"');
    expect(markup).toContain("Delete Willow?");
    expect(markup).toContain(">Cancel</button>");
    expect(markup).toContain(">Delete</button>");
    expect(markup).toContain("bg-danger");
  });
});

describe("bot deletion feedback", () => {
  it("disables the destructive action while the bot and its computer are deleted", () => {
    const markup = renderToStaticMarkup(createElement(BotDeleteMenuItem, {
      deleting: true,
      onClick: vi.fn(),
    }));

    expect(markup).toContain("Deleting bot and owned computer…");
    expect(markup).toContain('title="Deleting this bot and any computer it owns"');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('aria-busy="true"');
  });

  it("offers Delete again after the check settles", () => {
    const markup = renderToStaticMarkup(createElement(BotDeleteMenuItem, {
      deleting: false,
      onClick: vi.fn(),
    }));

    expect(markup).toContain(">Delete</button>");
    expect(markup).not.toContain('disabled=""');
  });
});
