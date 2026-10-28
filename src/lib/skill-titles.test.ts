import { describe, expect, it } from "vitest";

import { skillSubtitle, skillTitle } from "./skill-titles";

describe("skillTitle", () => {
  it.each([
    ["file-expense", "File an expense"],
    ["send-weekly-report", "Send a weekly report"],
    ["check-email", "Check email"],
    ["review-prs", "Review PRs"],
    ["write-seo-brief", "Write an SEO brief"],
    ["book-a-meeting", "Book a meeting"],
    ["post-to-linkedin", "Post to linkedin"],
    ["daily-standup", "Daily standup"],
    ["triage-sentry-issues", "Triage sentry issues"],
    ["create-user-account", "Create a user account"],
    ["deploy", "Deploy"],
    ["write-marketing-copy", "Write marketing copy"],
    ["make-pdf", "Make a PDF"],
  ])("%s → %s", (name, title) => {
    expect(skillTitle(name)).toBe(title);
  });
});

describe("skillSubtitle", () => {
  it("keeps only the first sentence", () => {
    expect(skillSubtitle("Files an expense in the company portal. Uses the saved card.")).toBe("Files an expense in the company portal.");
  });

  it("does not split on a version number and trims long text", () => {
    expect(skillSubtitle("Upgrades node to v24.1 safely")).toBe("Upgrades node to v24.1 safely");
    expect(skillSubtitle("x".repeat(200), 20)).toBe(`${"x".repeat(19)}…`);
  });
});
