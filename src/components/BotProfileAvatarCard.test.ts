import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { StoreProvider, type Bot } from "@/state/store";
import { MASCOT_BODY_IDS, MASCOT_BODIES } from "../../shared/mascot-bodies";
import { BotProfileAvatarCard } from "./BotProfileAvatarCard";

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    threadId: "thread-1",
    name: "Maus",
    title: "Maus",
    description: "",
    notifications: false,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "local", model: "test-model" },
    messages: [],
    ...overrides,
  };
}

function renderCard(bot: Bot) {
  return renderToStaticMarkup(
    createElement(
      StoreProvider,
      null,
      createElement(BotProfileAvatarCard, {
        bot,
        activeState: "idle",
        mascotMotion: null,
        onPatch: vi.fn(),
      }),
    ),
  );
}

describe("BotProfileAvatarCard body picker", () => {
  it("renders one option per body catalog entry, labeled by name", () => {
    const markup = renderCard(makeBot());

    expect(markup).toContain(">Body<");
    expect(markup).not.toContain(" expression</button>");
    expect(markup).not.toContain("Use idle expression");
    for (const id of MASCOT_BODY_IDS.filter(id => id !== "shield" && id !== "diamond")) {
      expect(markup).toContain(`aria-label="Use the ${({ cursor: "Triangle", star: "Cloud", blob: "Oval" } as Partial<Record<string, string>>)[id] ?? MASCOT_BODIES[id].name} body"`);
    }
  });

  it("marks the current body pressed and the rest unpressed, defaulting to circle", () => {
    const markup = renderCard(makeBot());

    expect(markup).toContain(`aria-pressed="true" aria-label="Use the Circle body"`);
    expect(markup).toContain(`aria-pressed="false" aria-label="Use the Cloud body"`);
  });

  it("reflects an explicitly chosen body", () => {
    const markup = renderCard(makeBot({ mascotBody: "star" }));

    expect(markup).toContain(`aria-pressed="true" aria-label="Use the Cloud body"`);
    expect(markup).toContain(`aria-pressed="false" aria-label="Use the Circle body"`);
  });

  it("hides the body picker for flat crops that have no mascot to wear one", () => {
    const markup = renderCard(makeBot({ avatarCrop: "circle" }));

    expect(markup).not.toContain(">Body<");
    expect(markup).not.toContain(`aria-label="Use the Circle body"`);
  });

  it("hides the body picker for every flat crop, not just circle", () => {
    for (const crop of ["rounded", "square"] as const) {
      const markup = renderCard(makeBot({ avatarCrop: crop }));

      expect(markup).not.toContain(">Body<");
    }
  });
});
