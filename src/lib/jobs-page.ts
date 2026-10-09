// The one jobs page: what is on the person ("your move"), what is moving,
// and what is done or paused. Pure helpers over the existing GET /api/jobs
// and GET /api/inbox rows; no new endpoint.
import type { InboxItem } from "./inbox";
import { jobNextStep, type JobInboxItem, type JobState } from "./job-inbox";

/** Only a live ask the person answers: approvals and questions. Failed runs,
 * unread replies and bot-to-bot lead reports are not theirs to do. */
export const isYourMoveAsk = (item: InboxItem): boolean =>
  !item.leadAction && (item.kind === "waiting-on-you" || item.kind === "question");

/** A blocked job is stuck on a gate only a person clears, so it sits with
 * the asks; the rest is work in motion. */
const YOURS: readonly JobState[] = ["needs-you", "blocked"];
const MOVING: readonly JobState[] = ["moving", "ready", "waiting"];

/** Split jobs into the page's sections, keeping the server's order inside each. */
export function splitJobs(items: readonly JobInboxItem[]) {
  return {
    yours: items.filter((item) => YOURS.includes(item.state)),
    moving: items.filter((item) => MOVING.includes(item.state)),
    paused: items.filter((item) => item.state === "paused"),
    done: items.filter((item) => item.state === "completed"),
  };
}

/** The live count the sidebar badge shows: asks plus jobs waiting on the person. */
export const yourMoveCount = (asks: readonly InboxItem[], jobs: readonly JobInboxItem[]): number =>
  asks.filter(isYourMoveAsk).length + jobs.filter((item) => YOURS.includes(item.state)).length;

// commit shas, file paths and branch names read as noise in a one-liner
const SHA = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gi;
const PATH = /(?:^|\s)(?:~|\.{1,2})?\/[^\s,;)]+|(?:^|\s)[\w.-]+\/[\w./-]*\.\w{1,5}\b/g;
const BRANCH = /\b(?:on|branch)\s+[\w.-]+\/[\w./-]+/gi;

/** A line in plain words: no shas, paths or branch names, one space apart. */
export function plainLine(text: string): string {
  return text
    .replace(BRANCH, " ")
    .replace(PATH, " ")
    .replace(SHA, " ")
    .replace(/\(\s*\)|\[\s*\]/g, " ")
    .replace(/\s+([,.;:)])(?=\s|$)/g, "$1")
    .replace(/([(])\s+/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,.;:-]+|[\s,;:-]+$/g, "")
    .trim();
}

export const SHORT_TITLE_MAX = 60;

/** Cut at a word boundary with an ellipsis once text runs past `max`. */
export function clip(text: string, max = SHORT_TITLE_MAX): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/** The outcome's first clause, about 60 characters. */
export function jobShortTitle(outcome: string): string {
  const plain = plainLine(outcome);
  const clause = plain.match(/^(.{6,}?)(?:[;:]\s|\s[-–—]\s|\.\s|,\s)/)?.[1] ?? plain;
  return clip(clause);
}

export type JobStatus =
  | { kind: "running" }
  | { kind: "waiting"; botId: string }
  | { kind: "blocked" }
  | { kind: "needs-you" }
  | { kind: "paused" }
  | { kind: "done" };

/** One status word for a row: running, waiting on <bot>, blocked, yours,
 * paused or done. */
export function jobStatus(item: JobInboxItem): JobStatus {
  if (item.state === "needs-you") return { kind: "needs-you" };
  if (item.state === "blocked") return { kind: "blocked" };
  if (item.state === "moving") return { kind: "running" };
  if (item.state === "paused") return { kind: "paused" };
  if (item.state === "completed") return { kind: "done" };
  const next = jobNextStep(item);
  return { kind: "waiting", botId: next?.ownerBotId || item.botId };
}

/** The "next:" line in plain words. A job on the person leads with why. */
export function jobNextLine(item: JobInboxItem): string {
  const next = jobNextStep(item);
  const stuck = item.steps.find((step) => step.status === "blocked");
  const raw = item.state === "needs-you"
    ? item.reason || next?.reason || next?.action || ""
    : item.state === "blocked"
      ? stuck?.reason || item.reason || stuck?.action || next?.action || ""
      : next?.action || item.reason || "";
  return plainLine(raw);
}
