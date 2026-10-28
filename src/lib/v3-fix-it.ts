// 3.0 fix-it cards: every failure the person can fix becomes one card with
// one button. Built from data the app already has: the health check
// (GET /api/doctor), relayed and linked bots' online state, v3 reconnect
// cards in needs-me, and bots whose run could not start. Pure on purpose;
// the sidebar fetches and renders.
import type { HealthReport } from "../../shared/doctor";
import type { BotActivity, RemoteBotOrigin } from "../../shared/wire";
import type { AppSettingsSection } from "@/state/store";
import type { HomeLink } from "./home-routing";
import type { InboxItem } from "./inbox";
import { t } from "./i18n";

export type FixItAction =
  | { kind: "settings"; section: AppSettingsSection }
  | { kind: "doctor"; action: "reconnect-whatsapp" }
  | { kind: "thread"; botId: string; threadId: string };

export interface FixIt {
  id: string;
  title: string;
  detail?: string;
  button: string;
  action: FixItAction;
}

export interface FixItBot {
  id: string;
  name: string;
  threadId: string;
  hidden?: boolean;
  activity?: BotActivity;
  tasks?: ReadonlyArray<{ threadId: string; activity?: BotActivity; routineRunId?: string }>;
  remote?: RemoteBotOrigin;
  homeLink?: HomeLink;
}

const STALLED: readonly BotActivity[] = ["dead", "no-signal"];

/** A bot whose run could not start. Its aggregate activity already ranks a
 * live ask and real work above this, so a stalled bot is never also busy. */
export const botStalled = (bot: Pick<FixItBot, "activity">): boolean =>
  Boolean(bot.activity && STALLED.includes(bot.activity));

/** The conversation to open for a stalled bot: the dead one, else its main thread. */
export function stalledThread(bot: FixItBot): string {
  return bot.tasks?.find((task) => !task.routineRunId && task.activity && STALLED.includes(task.activity))?.threadId ?? bot.threadId;
}

const hostName = (remote: RemoteBotOrigin) => remote.ownerName?.trim() ? `${remote.ownerName.trim()}'s Mac` : remote.homeName;

const remoteDown = (remote: RemoteBotOrigin) =>
  remote.online === false || Boolean(remote.availability && remote.availability !== "ready");

export interface FixItInput {
  report: HealthReport | null;
  bots: readonly FixItBot[];
  /** needs-me rows; only v3 reconnect cards become fix-its */
  asks?: readonly InboxItem[];
}

export function buildFixIts({ report, bots, asks = [] }: FixItInput): FixIt[] {
  const out: FixIt[] = [];
  const check = (id: string) => report?.checks.find((entry) => entry.id === id && entry.status === "warning");
  // The cli check warns for any configured engine without its CLI, even when
  // another engine works; alone it is not the person's problem. Only when no
  // engine is ready does a missing CLI say why.
  const engine = check("engine");
  const cli = engine && check("cli");
  if (cli) out.push({ id: "cli", title: t("v3.fixit.cli.title"), detail: cli.detail, button: t("v3.fixit.cli.button"), action: { kind: "settings", section: "engines" } });
  else if (engine) out.push({ id: "engine", title: t("v3.fixit.engine.title"), detail: engine.detail, button: t("v3.fixit.engine.button"), action: { kind: "settings", section: "engines" } });

  const visible = bots.filter((bot) => !bot.hidden);
  const homes = new Map<string, { remote: RemoteBotOrigin; bots: FixItBot[] }>();
  for (const bot of visible) {
    if (!bot.remote || !remoteDown(bot.remote)) continue;
    const home = homes.get(bot.remote.homeId) ?? { remote: bot.remote, bots: [] };
    home.bots.push(bot);
    homes.set(bot.remote.homeId, home);
  }
  for (const [homeId, home] of homes) {
    const name = hostName(home.remote);
    out.push({
      id: `computer:${homeId}`,
      title: t(home.remote.availability === "update-required" ? "v3.fixit.computer.update" : "v3.fixit.computer.title", { name }),
      detail: home.bots.length === 1 ? t("v3.fixit.computer.detailOne", { bot: home.bots[0]!.name }) : t("v3.fixit.computer.detail", { count: home.bots.length }),
      button: t("v3.fixit.computer.button"),
      action: { kind: "settings", section: "people" },
    });
  }
  const linked = new Map<string, { home: HomeLink; bots: FixItBot[] }>();
  for (const bot of visible) {
    if (!bot.homeLink || bot.homeLink.online) continue;
    const entry = linked.get(bot.homeLink.id) ?? { home: bot.homeLink, bots: [] };
    entry.bots.push(bot);
    linked.set(bot.homeLink.id, entry);
  }
  for (const [homeId, entry] of linked) {
    out.push({
      id: `server:${homeId}`,
      title: t("v3.fixit.computer.title", { name: entry.home.name }),
      detail: entry.bots.length === 1 ? t("v3.fixit.computer.detailOne", { bot: entry.bots[0]!.name }) : t("v3.fixit.computer.detail", { count: entry.bots.length }),
      button: t("v3.fixit.computer.button"),
      action: { kind: "settings", section: "desktopWorkspaces" },
    });
  }

  const seenApps = new Set<string>();
  for (const ask of asks) {
    if (!ask.connect?.reconnect || seenApps.has(ask.connect.slug)) continue;
    seenApps.add(ask.connect.slug);
    const bot = bots.find((entry) => entry.id === ask.botId);
    out.push({
      id: `app:${ask.connect.slug}`,
      title: t("v3.fixit.app.title", { app: ask.connect.label }),
      ...(bot ? { detail: t("v3.fixit.app.detail", { bot: bot.name }) } : {}),
      button: t("v3.fixit.app.button"),
      action: { kind: "thread", botId: ask.botId, threadId: ask.threadId },
    });
  }

  const whatsapp = check("whatsapp");
  if (whatsapp?.fix?.kind === "action" && report?.selfHealEnabled !== false) {
    out.push({ id: "whatsapp", title: t("v3.fixit.whatsapp.title"), button: t("v3.fixit.whatsapp.button"), action: { kind: "doctor", action: "reconnect-whatsapp" } });
  }

  // a signed-out engine is why every bot fails to start; one card says it
  if (!engine) {
    for (const bot of visible) {
      if (bot.remote || !botStalled(bot)) continue;
      out.push({
        id: `dead:${bot.id}`,
        title: t("v3.fixit.dead.title", { bot: bot.name }),
        detail: t("v3.fixit.dead.detail"),
        button: t("v3.fixit.dead.button"),
        action: { kind: "thread", botId: bot.id, threadId: stalledThread(bot) },
      });
    }
  }

  const disk = check("disk");
  if (disk) out.push({ id: "disk", title: t("v3.fixit.disk.title"), detail: disk.detail, button: t("v3.fixit.disk.button"), action: { kind: "settings", section: "health" } });
  return out;
}
