// 3.0 after-connect card: once an app is connected the card offers three
// things the bot can do with it right away. Each one is sent to the bot as
// the person's own message, so it reads naturally in the transcript and the
// bot needs no special handling. The renderer and the phone share this table.

export interface ConnectAction {
  /** Button text, and the exact message sent as the person. */
  text: string;
}

const TABLE: Record<string, readonly [string, string, string]> = {
  gmail: [
    "summarise my unread email",
    "draft replies to anything urgent",
    "every morning, brief me on new email",
  ],
  googlecalendar: [
    "what's on my calendar today?",
    "find a free hour for a meeting this week",
    "every morning, brief me on my day",
  ],
  googlesheets: [
    "list my recent spreadsheets",
    "summarise the numbers in my latest sheet",
    "every monday, report what changed in my sheets",
  ],
  googledrive: [
    "show me what changed in my drive this week",
    "find my latest proposal and summarise it",
    "every friday, tidy up new files in my drive",
  ],
  slack: [
    "catch me up on slack",
    "what needs a reply from me?",
    "every morning, brief me on slack mentions",
  ],
  notion: [
    "summarise my recently edited notion pages",
    "find my open to-dos in notion",
    "every friday, write a weekly recap page in notion",
  ],
  whatsapp: [
    "summarise my unread whatsapp chats",
    "who is waiting on a reply from me?",
    "every evening, brief me on whatsapp",
  ],
  instagram: [
    "how did my last few posts do?",
    "summarise new comments and dms",
    "every monday, report my instagram reach",
  ],
  facebook: [
    "how is my page doing this week?",
    "summarise new comments on my page",
    "every monday, report my page reach",
  ],
  metaads: [
    "how are my ads doing this week?",
    "which ad is wasting the most budget?",
    "every morning, report yesterday's ad spend",
  ],
};

/** Slugs that name the same toolkit. */
const ALIASES: Record<string, string> = {
  googlemail: "gmail",
  gcal: "googlecalendar",
  calendar: "googlecalendar",
  sheets: "googlesheets",
  drive: "googledrive",
  facebookads: "metaads",
  meta: "metaads",
  instagrambusiness: "instagram",
};

function canonical(slug: string): string {
  const key = slug.trim().toLowerCase().replace(/[\s_-]+/g, "");
  return ALIASES[key] ?? key;
}

/** Exactly three actions for a connected app. Unknown apps get a generic
 * set worded around the app's display label. */
export function connectActions(slug: string, label?: string): ConnectAction[] {
  const known = TABLE[canonical(slug)];
  if (known) return known.map((text) => ({ text }));
  const name = (label ?? slug).trim().toLowerCase() || "this app";
  return [
    `what can you do with ${name} now?`,
    `check ${name} for anything that needs me`,
    `every morning, brief me on what's new in ${name}`,
  ].map((text) => ({ text }));
}
