import type { InstalledPackageMetadata } from "../../shared/wire";
// Web-side mirror of server/bot-overview.ts's response shape for
// GET /api/bots/:id/overview. No logic lives here — the sentences are
// built once, server-side, so the phones and this dialog can never
// disagree about what a bot does.
export interface BotOverview {
  requirements?: InstalledPackageMetadata;
  toolAvailability?: { browser: boolean; computer: boolean };
  who: { name: string; title: string; blurb: string; soulLead: string };
  does: string[];
  reaches: string[];
  wont: string[];
  recent: Array<{ at: number; summary: string }>;
  /** Setup checklist; absent from servers older than this field. */
  setup?: SetupStep[];
  /** Verified connector inventory, without account identifiers or credentials. */
  connections?: { configured: boolean; authoritative: boolean; services: string[]; pending?: string[]; reconnect?: string[] };
}

export interface SetupStep {
  id: "identity" | "soul" | "folder" | "apps" | "schedule";
  label: string;
  done: boolean;
  section?: "identity" | "soul" | "access" | "routines";
}
