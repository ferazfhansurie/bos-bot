// Realtime voice calls (the Grok Bot-style "call your bot" mode).
//
// The phone and the desktop renderer open the xAI realtime socket
// themselves and do all audio locally. The server's only jobs are the two
// things a client must never own: the xAI key (we hand out a short-lived
// client secret instead) and the call plan (instructions + tools), so iOS,
// android and desktop all speak with the same rules.
import type { AppConfig } from "./config.ts";

export const VOICE_CALL_MODEL = "grok-voice-3.0";
export const VOICE_CALL_SOCKET = "wss://api.x.ai/v1/realtime";
/** long enough to dial and reconnect once; every reconnect mints again */
const SECRET_TTL_SECONDS = 300;
const XAI_API = "https://api.x.ai";

export const VOICE_CALL_VOICES = [
  "liora", "helix", "helios", "carina", "luna", "orion", "zagan", "kepler", "rigel", "atlas",
  "eve", "ara", "leo", "rex", "sal", "altair", "aurora", "castor", "celeste", "cosmo",
  "iris", "lumen", "lux", "naksh", "perseus", "sirius", "ursa", "zenith",
] as const;
export const VOICE_CALL_SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;
export const VOICE_CALL_LANGUAGES = [
  "auto", "en", "ms", "zh", "id", "ta", "ar-EG", "ar-SA", "ar-AE", "bn", "ca", "da", "nl", "fi", "fr", "de",
  "hi", "hu", "it", "ja", "ko", "pl", "pt-BR", "pt-PT", "ru", "es-MX", "es-ES", "sv", "th", "tr", "vi",
] as const;

export class NoVoiceCallKey extends Error {
  constructor() {
    super("Add an xAI key in Settings on the computer to turn on voice calls.");
  }
}

export interface VoiceCallCredential {
  clientSecret: string;
  expiresAt: number;
  model: string;
  websocketUrl: string;
}

/** Mint a short-lived secret the client sends as the websocket subprotocol
 * `xai-client-secret.<secret>`. The raw key never leaves this process. */
export async function mintVoiceCallCredential(
  cfg: AppConfig,
  fetchImpl: typeof fetch = fetch,
  apiBase = XAI_API,
): Promise<VoiceCallCredential> {
  const key = cfg.xai?.key?.trim();
  if (!key) throw new NoVoiceCallKey();
  const res = await fetchImpl(`${apiBase}/v1/realtime/client_secrets`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ expires_after: { seconds: SECRET_TTL_SECONDS } }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) {
    // xAI's error body names the problem (bad key, no credits); the key itself is never in it
    throw new Error(`xAI refused the voice call (${res.status}): ${text.slice(0, 300)}`);
  }
  let body: { value?: unknown; expires_at?: unknown; client_secret?: { value?: unknown; expires_at?: unknown } };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("xAI returned an unreadable voice call secret");
  }
  const secret = body.value ?? body.client_secret?.value;
  const expiresAt = body.expires_at ?? body.client_secret?.expires_at;
  if (typeof secret !== "string" || !secret) throw new Error("xAI returned no voice call secret");
  return {
    clientSecret: secret,
    expiresAt: typeof expiresAt === "number" ? expiresAt : Math.floor(Date.now() / 1000) + SECRET_TTL_SECONDS,
    model: VOICE_CALL_MODEL,
    websocketUrl: VOICE_CALL_SOCKET,
  };
}

const TOOLS = [
  {
    type: "function",
    name: "send_task",
    description:
      "Send a job that needs their computer, files, web, browser, or mail and chat they send. That call is a receipt, never the answer, and never the quick path. Speak a short beat on this response that names the job in how you talk, then call this. Never start that beat with a confirmation. Never say you are calling this tool. The outcome lands later as a work_landed entry. Send each job once: a job already sent on this call is running, so never send it again, even when they repeat it or ask about it. When they ask whether something is done, answer from the work_landed entries on this call, or say it is still running if nothing has landed for it; never call this to check. Do not use this for a take, a recap of this call, a quiz from words already on the line, a story, a joke, talk they asked you to do yourself, a fact already on the line, or a name or value they just spoke on this call — answer from that speech instead. If the useful answer needs a fact you do not have about their world, recall_text_messages first when it might already be in this written chat; use this only when it is not there.",
    parameters: {
      type: "object",
      properties: {
        request: {
          type: "string",
          description:
            "What the caller asked for, restated cleanly in first person as they would type it themselves: \"check how many bots are online and tell me\", \"I want the invoice sent to Sam today\". Their own words and intent, minus filler and false starts. Never third person: never \"Firaz wants...\", \"the user asks...\", \"they want...\". Never your own plan or paraphrase of the job. Maximum 2000 characters; preserve every constraint, prohibition, and approval requirement. Overlong requests are rejected, never truncated.",
        },
      },
      required: ["request"],
    },
  },
  {
    type: "function",
    name: "recall_text_messages",
    description:
      'Read the written chat between you and this caller: "you" is what you sent them, "them" is what they typed to you. Nobody else writes in it. Oldest first. If the answer might already be in the written chat, call recall_text_messages. Do not guess it, do not say you do not know, and do not send_task for it until you have read that chat. Say nothing about calling this.',
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "stay_silent",
    description:
      "Say nothing this turn. This is only for a last-landed work_landed or work_overheard entry, when speaking would give them nothing new. Never use it when they just talked to you. Never on the unpaid turn after send_task. Never on a work_landed outcome they have not heard. Never on the same turn as spoken words. The caller hears nothing. Say nothing about calling this.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "end_the_call",
    description:
      'Hang up and end this call. Use it only when the caller says a parting greeting like "all done", "bye", "thanks, that\'s all", "stop", "go away", "shut up", "stop listening", "leave me alone", "goodbye", or "hang up". An unclear pause, a task still open, "ok" in the middle of work, or a "stop" that cancels that work is not a hang-up. ALWAYS say your goodbye out loud first, including when hanging up is the last step of something else they asked for: the line drops the moment you call this, so nothing after it is heard. Never call it while they are still asking for something.',
    parameters: { type: "object", properties: {} },
  },
] as const;

/** "Maus (old name)" -> "Maus": parenthetical notes read badly out loud */
function spokenName(name: string | undefined, fallback: string): string {
  const clean = (name ?? "").replace(/\s*\([^)]*\)\s*/g, " ").trim();
  return clean || fallback;
}

export interface VoiceCallPlan {
  instructions: string;
  greeting: { direction: string };
  tools: typeof TOOLS;
  /** what the client tells the model after send_task returns its receipt */
  receiptTurn: string;
  /** what send_task returns when the request is empty or too long */
  maxRequestChars: number;
}

export function voiceCallPlan(input: {
  agentName?: string;
  userName?: string;
  description?: string;
  language?: string;
}): VoiceCallPlan {
  const agent = spokenName(input.agentName, "your assistant");
  const caller = spokenName(input.userName, "");
  const firstName = caller.split(/\s+/)[0] ?? "";
  const about = input.description?.trim();
  const language = input.language && input.language !== "auto" ? input.language : "";
  const instructions = [
    "## Role & Persona",
    `You are ${agent}, on a live phone call with the person you work for${firstName ? `, ${firstName}` : ""}. Nobody else is on this line.`,
    about ? `What you do for them: ${about}` : "",
    "",
    "## Instruction and tools",
    "Default to talking. Small talk, a take, a recap of this call, a story, a joke, and anything you already have on this line need no tool.",
    "send_task only when they want something done or looked up that is not already here.",
    "send_task's request is their ask in their own words, first person, as they would type it. Never third person, never \"they want\" or their name.",
    "If the answer might already be in your written chat with them, recall_text_messages first.",
    "When they say a parting greeting, one short goodbye out loud, then end_the_call, even when hanging up is the last step of another request.",
    "",
    "## Conversation Flow",
    "send_task is never the quick path. Speak a short beat on this response that names the job in how you talk, then call it. Never start that beat with a confirmation. Never say you are calling the tool.",
    "Keep turns short: one or two spoken sentences, then let them talk.",
    "",
    "## While work is in flight",
    "Never re-announce you are still working within about 30 seconds of your last line.",
    "Never chase or poll the work; it reports back on its own. An empty tool result is not news.",
    "Each job goes out once. A job you already sent on this call is running: never send_task it again, even when they repeat it.",
    "When they ask whether something is done, answer from the work_landed entries on this call. If nothing has landed for it, say it is still running. Never send_task to check.",
    "A work_landed entry is the task finished, or real progress on it. Tell them what came back, in a sentence or two.",
    "A work_overheard entry is work still in progress; never spoken.",
    "",
    "## When they talk over you",
    "When they talk over you, stop and listen; they heard only the start.",
    "",
    "## Never claim it is done",
    "Say something is finished only when what came back says so; started is not ended.",
    "",
    "## Voice",
    "Spoken words only: no stage directions, no markdown, no ids or file paths unless they ask.",
    "Sound like a teammate on the phone: casual, warm, direct.",
    language ? `Speak and listen in ${language}.` : "Answer in the language they speak to you.",
    "",
    "CRITICAL INSTRUCTIONS",
    "Open the call in one short spoken line. If they have already spoken, answer that and skip the greeting. Do not introduce yourself.",
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
  return {
    instructions,
    greeting: {
      direction: `Open the call in one short, casual spoken line${firstName ? ` to ${firstName}` : ""}. Do not introduce yourself.`,
    },
    tools: TOOLS,
    receiptTurn: "The job is under way. Keep talking with a natural question or a suggestion. Do not announce that you started.",
    maxRequestChars: 2000,
  };
}

// ── v3 ───────────────────────────────────────────────────────────────────
// Spec: plans/voice-v3/contract.md. A client that sends `v: 3` on the mint
// gets this plan; an older client keeps the v2 plan above (it would answer
// confirm_job and the read tools with "there is no tool named ...").

const V3_SEND_TASK = {
  type: "function",
  name: "send_task",
  description:
    "Hold a job that needs their computer, files, web, mail, or another bot: real work, not a read. This does NOT start it. It returns a read-back: say it exactly, then wait. Only when they clearly say go (\"go\", \"yes\", \"do it\", \"ya\") call confirm_job with decision go; anything else (\"no\", \"wait\", a correction) is cancel, then send the corrected job again. If it returns status unclear, say its say and nothing more. Never for something you can answer from the brief or a read tool.",
  parameters: {
    type: "object",
    properties: {
      request: {
        type: "string",
        description:
          "The job in their own words, first person, as they would type it: \"tell oracle to check prod errors\", \"draft partner a reply: invoice goes tomorrow\". Minus filler and false starts. Never third person. Keep every name, number, constraint and approval requirement. At most 2000 characters.",
      },
      bot: {
        type: "string",
        description: "Which teammate does it, by name from the roster, when they named one or it is clearly that teammate's work. Leave it out to keep it with you.",
      },
      readback: {
        type: "string",
        description: "The job in at most 8 spoken words, starting with the teammate's name when it goes to someone else: \"oracle: check prod errors\".",
      },
    },
    required: ["request", "readback"],
  },
} as const;

const V3_TOOLS = [
  V3_SEND_TASK,
  {
    type: "function",
    name: "confirm_job",
    description: "Their answer to a read-back. go: they clearly said yes, the job is saved and starts in its own thread. cancel: anything else. Say only the say it returns.",
    parameters: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "The job_id send_task returned." },
        decision: { type: "string", enum: ["go", "cancel"] },
      },
      required: ["job_id", "decision"],
    },
  },
  TOOLS[1], // recall_text_messages
  TOOLS[2], // stay_silent
  TOOLS[3], // end_the_call
  {
    type: "function",
    name: "check_jobs",
    description: "How the jobs from this call (and today's earlier calls) are going: running, done with the result, or waiting on them. Use it when they ask \"is it done\", \"how's that going\".",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "recall_memory",
    description: "Search your long-term memory and notes for something not already in the brief: a person, a decision, a number.",
    parameters: { type: "object", properties: { query: { type: "string", description: "Two to five words." } }, required: ["query"] },
  },
  {
    type: "function",
    name: "calendar",
    description: "What is scheduled on a day: their routines, bos calls, and what already ran today.",
    parameters: { type: "object", properties: { day: { type: "string", description: "today, tomorrow, or YYYY-MM-DD. Default today." } } },
  },
  {
    type: "function",
    name: "status",
    description: "The latest on a topic from their threads, routines and memory: \"ad e\", \"partner\", \"the install\". Use it before answering a status question the brief does not cover.",
    parameters: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] },
  },
  {
    type: "function",
    name: "needs_me",
    description: "What is waiting on them right now: approvals and questions from their bots, numbered. Read the first one only, then ask yes, skip or later.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "answer_item",
    description: "Answer one item from needs_me with what they said. Tool approvals, client messages, spending and prod writes are never answered by voice: it will say they need a tap on screen.",
    parameters: {
      type: "object",
      properties: {
        item: { type: "string", description: "The item number from needs_me." },
        answer: { type: "string", description: "Their answer in their words, or the option they chose." },
      },
      required: ["item", "answer"],
    },
  },
  {
    type: "function",
    name: "follow_up",
    description: "Add something to a job from this call instead of starting a new one: \"also check yesterday\", \"make it shorter\". About an older thread, it starts a new thread that names that one.",
    parameters: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "The job_id, when it is a job from this call." },
        topic: { type: "string", description: "Otherwise a few words naming the job or thread." },
        text: { type: "string", description: "What to add, first person, their words." },
      },
      required: ["text"],
    },
  },
] as const;

export type VoiceCallPlanV3 = Omit<VoiceCallPlan, "tools"> & {
  v: 3;
  tools: typeof V3_TOOLS;
  keyterms: string[];
  roster: Array<{ id: string; name: string }>;
};

export function voiceCallPlanV3(input: {
  agentName?: string;
  userName?: string;
  description?: string;
  language?: string;
  brief?: string;
  keyterms?: string[];
  roster?: Array<{ id: string; name: string }>;
}): VoiceCallPlanV3 {
  const agent = spokenName(input.agentName, "your assistant");
  const caller = spokenName(input.userName, "");
  const firstName = caller.split(/\s+/)[0] ?? "";
  const about = input.description?.trim();
  const language = input.language && input.language !== "auto" ? input.language : "";
  const roster = (input.roster ?? []).map((bot) => ({ id: bot.id, name: spokenName(bot.name, bot.id) }));
  const teammates = roster.filter((bot) => bot.name.toLowerCase() !== agent.toLowerCase()).map((bot) => bot.name);
  const instructions = [
    "## Role",
    `You are ${agent}, on a live phone call with the person you work for${firstName ? `, ${firstName}` : ""}. Nobody else is on this line. They call from the car, the gym or a walk: hands and eyes busy, often noisy.`,
    about ? `What you do for them: ${about}` : "",
    teammates.length ? `Your teammates, who can take jobs: ${teammates.join(", ")}.` : "",
    "",
    "## Answers fit the ear",
    "At most two spoken sentences. Round numbers. Never list more than three things; if there is more, say how many and ask \"want the rest in chat?\".",
    "Answer from the brief below or a read tool (check_jobs, recall_memory, calendar, status, needs_me). Never invent a number, name or outcome. If you do not have it, say so in a few words and offer to make it a job.",
    "",
    "## Jobs",
    "Real work (doing something, writing something, checking something only a computer can) is a job. Call send_task with their request and a readback, then say the read-back it returns and wait.",
    "Only a clear go starts it: call confirm_job go. Anything else cancels. Never confirm on their behalf, never on a pause.",
    "Each job once. A saved job is running in its own thread: for more on it use follow_up, for how it is going use check_jobs.",
    "Client messages, spending money and production data changes are never done by voice: the job drafts it and it waits for a tap on their screen. Say so if they ask to send or pay now.",
    "",
    "## Hearing",
    "If you did not catch it, or it was noise, music or breathing, say \"say that again?\" and nothing else. Never guess a name or a job.",
    "Ignore background noise and pauses. Do not fill silence. When they talk over you, stop and listen.",
    "",
    "## Waiting on them",
    "For needs_me, read one item at a time in a sentence, then \"yes, skip or later?\". Never read ids or numbers of items aloud beyond \"first\", \"next\". Answer with answer_item.",
    "",
    "## Voice",
    "Spoken words only: no markdown, no ids, no file paths, no links.",
    "Sound like a teammate on the phone: casual, warm, direct. Never say you are calling a tool.",
    language ? `Speak and listen in ${language}.` : "Answer in the language they speak to you.",
    "When they say a parting greeting, one short goodbye out loud, then end_the_call.",
    "",
    "## Brief (what you know right now; it is current as of the call start)",
    input.brief?.trim() || "(nothing loaded)",
    "",
    "CRITICAL INSTRUCTIONS",
    "Open the call in one short spoken line. If they have already spoken, answer that and skip the greeting. Do not introduce yourself. Do not read the brief out unless they ask.",
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
  return {
    v: 3,
    instructions,
    greeting: {
      direction: `Open the call in one short, casual spoken line${firstName ? ` to ${firstName}` : ""}. Do not introduce yourself.`,
    },
    tools: V3_TOOLS,
    receiptTurn: "The job is saved and running. Keep talking with a natural question or a suggestion. Do not announce that you started.",
    maxRequestChars: 2000,
    keyterms: input.keyterms ?? [],
    roster,
  };
}
