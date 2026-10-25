// What the main window tells the notch (electron/notch.mjs), and what the
// notch asks the main window to do. The notch page holds no data of its own:
// every field here was already on screen somewhere in the app.
import type { ActivityState } from "@/lib/activity-feed";
import type { MascotBodyId } from "../../shared/mascot-bodies";

export interface NotchBot {
  id: string;
  name: string;
  /** palette name or "#RRGGBB", as the bot record stores it */
  color: string;
  body: MascotBodyId | null;
  /** the thread the notch opens for this bot */
  threadId: string;
  /** that thread's title */
  title: string;
  state: ActivityState;
  /** when the bot entered this state, epoch ms */
  since: number;
}

export interface NotchAsk {
  /** this one request: the inbox row's id plus the live request (or card)
   * it is about. A conversation's row id is reused for its next ask, so an
   * answer names this, and lands only if the same request is still there. */
  id: string;
  botId: string;
  threadId: string;
  kind: "approval" | "question";
  title: string;
  /** what the bot is asking, trimmed */
  preview: string;
  /** a question's choices, when it offers some: the label is trimmed for
   * the notch, the value is what an answer sends, untouched */
  options?: Array<{ label: string; value: string }>;
  /** a question that takes typed words */
  freeText: boolean;
  /** the notch makes its one sound for this ask (no banner will) */
  chime: boolean;
  at: number;
}

export interface NotchMoment {
  id: string;
  kind: "done" | "failed";
  botId: string;
  threadId: string;
  title: string;
  /** the start of what the bot said when it finished, if it is on hand */
  preview?: string;
  at: number;
}

export interface NotchSnapshot {
  /** working bots, most urgent first; the wing shows the first three */
  working: NotchBot[];
  /** the shelf: everyone live, then the most recent few at rest */
  shelf: NotchBot[];
  /** bots by id, for asks and moments whose bot is resting */
  bots: Record<string, Pick<NotchBot, "id" | "name" | "color" | "body">>;
  asks: NotchAsk[];
  moments: NotchMoment[];
}

export type NotchAnswer = { behavior: "allow" | "deny" } | { option: string } | { text: string };

export type NotchAction =
  | { type: "open"; botId: string; threadId: string }
  | { type: "answer"; askId: string; answer: NotchAnswer }
  /** quick ask: words for a bot, sent into the thread it is on now */
  | { type: "ask"; botId: string; threadId: string; text: string };

/** files dropped on a bot: built by the preload and electron/notch.mjs from
 * real dropped Files, never by the page; the main window receives it */
export type NotchDrop = { type: "drop"; botId: string; threadId: string; files: Array<{ name: string; path: string; size: number }> };

export type NotchGeometry = {
  mode: "notch" | "pill";
  /** the camera housing, points; width 0 in pill mode */
  notch: { width: number; height: number };
  menuBar: number;
  /** an app is full screen on this display: only an ask may show */
  fullscreen?: boolean;
  window: { width: number; height: number };
};

export type NotchPointer = { kind: "hover" | "drag"; phase: "enter" | "exit" };
