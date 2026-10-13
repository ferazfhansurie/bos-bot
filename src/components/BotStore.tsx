// The marketplace's Explore shelf: real bots you can get, one at a time.
//
// bos sits on top as the house bot. Under it, the community bots from
// botdirectory.ai (the same index the folder scout already reads), filtered
// by category chip and the panel's search. A bot opens into its page first —
// the full prompt it will run on, the apps it wants, who made it — and only
// "Get" creates anything: an ordinary POST /api/bots with the prompt as the
// bot's description, the same as making a bot and pasting the prompt in.
// Apps still connect only through a card the person authorizes.
import { ArrowLeft, Check, ExternalLink, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { track } from "@/lib/analytics";
import { api, useStore, type Bot } from "@/state/store";
import { MausAvatar } from "./Avatar";
import { ServiceIcon } from "./PluginsPanel";
import { MASCOT_BODY_IDS, type MascotBodyId } from "../../shared/mascot-bodies";
import { MAUS_COLOR_NAMES } from "../../shared/glyph-faces";

// Bots with no saved look still show as a mascot, never a letter tile: the
// body and colour come from the name, so the same bot looks the same every
// time it is shown. White and gray read as "nothing chosen", so they are left
// out of the fallback palette.
const FALLBACK_COLORS = MAUS_COLOR_NAMES.filter((color) => color !== "white" && color !== "gray");

function hashOf(text: string): number {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
}

/** The look a bot gets: its saved body/colour, or one picked from its name. */
export function mascotLook(name: string, color?: string, body?: string): { bodyId: MascotBodyId; color: string } {
  const hash = hashOf(name);
  return {
    bodyId: (MASCOT_BODY_IDS as readonly string[]).includes(body ?? "") ? (body as MascotBodyId) : MASCOT_BODY_IDS[hash % MASCOT_BODY_IDS.length]!,
    color: color ?? FALLBACK_COLORS[(hash >>> 8) % FALLBACK_COLORS.length]!,
  };
}

export function MemberMascot({ name, color, body, size = 36 }: { name: string; color?: string; body?: string; size?: number }) {
  const look = mascotLook(name, color, body);
  return <MausAvatar bodyId={look.bodyId} color={look.color as never} size={size} label={name} />;
}

export interface DirectoryBot {
  slug: string;
  name: string;
  category: string;
  integrations: string[];
  prompt: string;
  detailUrl: string;
  contributor?: string;
}

/** A bot on the shelf, whether it is bos or from the community. */
interface StoreBot {
  slug: string;
  name: string;
  category: string;
  /** one line for the card */
  tagline: string;
  /** what it runs on: becomes the new bot's description */
  prompt: string;
  /** standing instructions, only for bots we wrote ourselves */
  soul?: string;
  integrations: string[];
  maker: string;
  color?: string;
  body?: string;
  detailUrl?: string;
}

const BOS: StoreBot = {
  slug: "bos",
  name: "bos",
  category: "Co-founder",
  tagline: "Your co-founder. Runs the agency, the product and your life admin, and does the work itself.",
  prompt:
    "bos is a co-founder, not an assistant. It owns outcomes across your business, your product and your personal admin: it plans, builds, checks the real result and tells you when it's done. It works through sub-agents when things can run in parallel, keeps one thread per task, and wakes up on its own when someone owes you a reply or something is coming up. It asks you only for spending, messages to clients, sign-ins and MFA.",
  soul: [
    "you are bos, the user's co-founder. you own outcomes, not tasks: agency work, the product, and their personal admin.",
    "talk like texting a teammate: lowercase, short, no emojis, no recaps or progress narration.",
    "do the work yourself and use sub-agents when parts can run in parallel. one task = one thread. done means you checked the real result.",
    "when a reply leaves a natural follow-up (someone owes them a reply, they said \"later\", an event is coming), set a reminder and come back to it.",
    "hard lines: ask the user before spending money, messaging their clients or customers, signing in or MFA, and before any write to a production database. keep client, personal and company data separate.",
  ].join("\n\n"),
  integrations: ["Gmail", "Google Calendar", "GitHub", "Slack"],
  maker: "BOS",
  color: "white",
  body: "circle",
};

const APP_SLUGS: Record<string, string> = {
  "google calendar": "googlecalendar",
  "google sheets": "googlesheets",
  "google drive": "googledrive",
  "google analytics": "google_analytics",
  x: "twitter",
};

function appSlug(name: string): string {
  const key = name.trim().toLowerCase();
  return APP_SLUGS[key] ?? key.replace(/[^a-z0-9]+/g, "");
}

function AppLogo({ name, className = "size-5" }: { name: string; className?: string }) {
  return (
    <span title={name} className={cn("flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-raised", className)}>
      <ServiceIcon card={{ label: name, logo: `https://logos.composio.dev/api/${appSlug(name)}`, domain: null }} className="size-full rounded-md" />
    </span>
  );
}

/** First sentence of a community prompt, as the card's tagline. */
function firstSentence(prompt: string): string {
  const match = prompt.match(/^.*?[.!?](\s|$)/);
  return (match ? match[0] : prompt).trim();
}

function fromDirectory(entry: DirectoryBot): StoreBot {
  return {
    slug: entry.slug,
    name: entry.name,
    category: entry.category || "Community",
    tagline: firstSentence(entry.prompt),
    prompt: entry.prompt,
    integrations: entry.integrations,
    maker: entry.contributor ? `@${entry.contributor}` : "Community",
    detailUrl: entry.detailUrl,
  };
}

export function BotStore({
  search,
  onGot,
  openExternal,
}: {
  search: string;
  /** the bot was created; the panel closes and the new chat opens */
  onGot: (bot: Bot) => void;
  openExternal: (url: string) => void;
}) {
  const { dispatch } = useStore();
  const [directory, setDirectory] = useState<DirectoryBot[] | null>(null);
  const [error, setError] = useState("");
  const [category, setCategory] = useState("All");
  const [viewing, setViewing] = useState<StoreBot | null>(null);
  const [getting, setGetting] = useState<string | null>(null);
  const [getError, setGetError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      // SAFETY: this endpoint is owned by the app and returns { bots: DirectoryBot[] }.
      const response = (await api("/api/bot-directory")) as { bots: DirectoryBot[] };
      setDirectory(response.bots);
    } catch (cause) {
      setDirectory([]);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const community = useMemo(() => (directory ?? []).map(fromDirectory), [directory]);
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const bot of community) counts.set(bot.category, (counts.get(bot.category) ?? 0) + 1);
    return ["All", ...[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name)];
  }, [community]);

  const query = search.trim().toLowerCase();
  const matches = (bot: StoreBot) =>
    (category === "All" || bot.category === category) &&
    (!query || `${bot.name} ${bot.category} ${bot.prompt} ${bot.integrations.join(" ")}`.toLowerCase().includes(query));
  const shelf = community.filter(matches);
  const showBos = category === "All" && (!query || `${BOS.name} ${BOS.category} ${BOS.prompt}`.toLowerCase().includes(query));

  const get = async (bot: StoreBot) => {
    if (getting) return;
    setGetting(bot.slug);
    setGetError("");
    try {
      const { bot: created } = (await api("/api/bots", {
        method: "POST",
        body: JSON.stringify({
          name: bot.name,
          title: bot.category,
          description: bot.prompt,
          ...(bot.soul ? { soul: bot.soul } : {}),
        }),
      })) as { bot: Bot };
      const look = mascotLook(bot.name, bot.color, bot.body);
      let added: Bot = created;
      try {
        // the look is cosmetic: a failed patch still leaves a working bot
        const { bot: patched } = (await api(`/api/bots/${created.id}`, {
          method: "PATCH",
          body: JSON.stringify({ color: look.color, mascotBody: look.bodyId }),
        })) as { bot: Bot };
        added = { ...created, ...patched, messages: created.messages };
      } catch {
        // keep the bot as created
      }
      dispatch({ type: "botAdded", bot: added });
      dispatch({ type: "select", id: added.id });
      track("store_bot_added", { slug: bot.slug, source: bot.slug === "bos" ? "house" : "directory" });
      onGot(added);
    } catch (cause) {
      setGetError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setGetting(null);
    }
  };

  if (viewing) {
    return (
      <BotPage
        bot={viewing}
        getting={getting === viewing.slug}
        error={getError}
        onBack={() => {
          setViewing(null);
          setGetError("");
        }}
        onGet={() => void get(viewing)}
        openExternal={openExternal}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {showBos && <Featured bot={BOS} onOpen={() => setViewing(BOS)} onGet={() => void get(BOS)} getting={getting === BOS.slug} />}

      <div>
        <div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Bot categories">
          {categories.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={category === name}
              onClick={() => setCategory(name)}
              className={cn(
                "h-8 rounded-full px-3.5 text-[13px] transition-colors",
                category === name ? "bg-ink text-app" : "bg-raised/70 text-ink-secondary hover:bg-raised-hover hover:text-ink",
              )}
            >
              {name}
            </button>
          ))}
        </div>

        {directory === null && (
          <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-ink-secondary">
            <Loader2 size={16} className="animate-spin" /> Loading bots…
          </div>
        )}
        {error && (
          <div className="rounded-2xl bg-danger/10 p-4 text-[13px] text-danger">
            <p>{error}</p>
            <button type="button" onClick={() => void load()} className="mt-3 rounded-full bg-raised px-3.5 py-2 text-ink hover:bg-raised-hover">
              Try again
            </button>
          </div>
        )}
        {getError && !viewing && <div role="alert" className="mb-3 rounded-xl bg-danger/10 px-3 py-2 text-[13px] text-danger">{getError}</div>}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {shelf.map((bot) => (
            <BotCard key={bot.slug} bot={bot} onOpen={() => setViewing(bot)} onGet={() => void get(bot)} getting={getting === bot.slug} busy={getting !== null} />
          ))}
        </div>
        {directory !== null && !error && shelf.length === 0 && !showBos && (
          <div className="flex min-h-40 flex-col items-center justify-center text-center">
            <div className="text-[14px] font-medium text-ink">No bots found</div>
            <div className="mt-1 text-[13px] text-ink-secondary">Try a different search or category.</div>
          </div>
        )}
      </div>
    </div>
  );
}

function GetButton({ onClick, getting, disabled, big = false }: { onClick: () => void; getting: boolean; disabled?: boolean; big?: boolean }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      disabled={disabled || getting}
      className={cn(
        "flex shrink-0 items-center justify-center gap-1.5 rounded-full bg-ink font-medium text-app transition-[opacity,transform] hover:opacity-90 active:scale-95 disabled:opacity-50",
        big ? "h-10 min-w-[96px] px-5 text-[14px]" : "h-8 min-w-[60px] px-3.5 text-[13px]",
      )}
    >
      {getting ? <Loader2 size={14} className="animate-spin" /> : "Get"}
    </button>
  );
}

function Featured({ bot, onOpen, onGet, getting }: { bot: StoreBot; onOpen: () => void; onGet: () => void; getting: boolean }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => event.key === "Enter" && onOpen()}
      className="animate-pop-in relative flex cursor-pointer items-center gap-5 overflow-hidden rounded-[22px] bg-gradient-to-br from-raised to-card px-6 py-5 text-start transition-colors hover:from-raised-hover"
    >
      <div className="flex size-[88px] shrink-0 items-center justify-center rounded-[26px] bg-app/60">
        <MemberMascot name={bot.name} color={bot.color} body={bot.body} size={68} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">Featured · made by {bot.maker}</div>
        <div className="mt-1 text-[22px] font-semibold leading-tight text-ink">{bot.name}</div>
        <p className="mt-1 line-clamp-2 max-w-[560px] text-[14px] leading-snug text-ink-secondary">{bot.tagline}</p>
        <div className="mt-2.5 flex items-center gap-1.5">
          {bot.integrations.map((app) => (
            <AppLogo key={app} name={app} />
          ))}
        </div>
      </div>
      <GetButton onClick={onGet} getting={getting} big />
    </div>
  );
}

function BotCard({ bot, onOpen, onGet, getting, busy }: { bot: StoreBot; onOpen: () => void; onGet: () => void; getting: boolean; busy: boolean }) {
  return (
    <article
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => event.key === "Enter" && onOpen()}
      className="flex cursor-pointer flex-col gap-3 rounded-[20px] bg-card px-4 py-4 transition-colors hover:bg-raised"
    >
      <div className="flex items-center gap-3">
        <MemberMascot name={bot.name} color={bot.color} body={bot.body} size={44} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[14.5px] font-medium text-ink">{bot.name}</h3>
          <div className="truncate text-[12.5px] text-ink-secondary">{bot.category}</div>
        </div>
        <GetButton onClick={onGet} getting={getting} disabled={busy} />
      </div>
      <p className="line-clamp-2 min-h-[2.6em] text-[13px] leading-snug text-ink-secondary">{bot.tagline}</p>
      <div className="flex items-center gap-1.5">
        {bot.integrations.slice(0, 5).map((app) => (
          <AppLogo key={app} name={app} />
        ))}
        <span className="ms-auto truncate text-[11.5px] text-ink-secondary/80">{bot.maker}</span>
      </div>
    </article>
  );
}

function BotPage({
  bot,
  getting,
  error,
  onBack,
  onGet,
  openExternal,
}: {
  bot: StoreBot;
  getting: boolean;
  error: string;
  onBack: () => void;
  onGet: () => void;
  openExternal: (url: string) => void;
}) {
  // the shelf may be scrolled far down when a card is opened
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => top.current?.scrollIntoView({ block: "start" }), []);
  return (
    <div ref={top} className="animate-pop-in mx-auto flex max-w-[680px] flex-col scroll-mt-6">
      <button type="button" onClick={onBack} className="-ms-2 flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink">
        <ArrowLeft size={15} /> All bots
      </button>
      <div className="mt-4 flex items-center gap-5">
        <div className="flex size-[96px] shrink-0 items-center justify-center rounded-[28px] bg-raised">
          <MemberMascot name={bot.name} color={bot.color} body={bot.body} size={72} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[24px] font-semibold leading-tight text-ink">{bot.name}</div>
          <div className="mt-1 text-[13.5px] text-ink-secondary">
            {bot.category} · by {bot.maker}
          </div>
        </div>
        <GetButton onClick={onGet} getting={getting} big />
      </div>
      {error && <div role="alert" className="mt-4 rounded-xl bg-danger/10 px-3 py-2 text-[13px] text-danger">{error}</div>}

      <div className="mt-6 text-[13px] font-medium text-ink-secondary">What it does</div>
      <p className="mt-2 whitespace-pre-wrap rounded-[18px] bg-card px-5 py-4 text-[14.5px] leading-relaxed text-ink">{bot.prompt}</p>

      {bot.integrations.length > 0 && (
        <>
          <div className="mt-6 text-[13px] font-medium text-ink-secondary">Works with</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {bot.integrations.map((app) => (
              <span key={app} className="flex h-9 items-center gap-2 rounded-full bg-card pe-3.5 ps-1.5 text-[13px] text-ink">
                <AppLogo name={app} className="size-6" />
                {app}
              </span>
            ))}
          </div>
        </>
      )}

      <div className="mt-6 flex items-start gap-2.5 rounded-[18px] bg-raised/45 px-4 py-3 text-[13px] leading-relaxed text-ink-secondary">
        <Check size={15} className="mt-0.5 shrink-0 text-success" />
        <p>It arrives as a new bot with this as its brief. Nothing is connected yet: it shows you a connect card for each app and waits for you to authorize it.</p>
      </div>
      {bot.detailUrl && (
        <button
          type="button"
          onClick={() => openExternal(bot.detailUrl!)}
          className="mt-4 flex w-fit items-center gap-1.5 text-[13px] text-ink-secondary hover:text-ink"
        >
          View on botdirectory.ai <ExternalLink size={12} />
        </button>
      )}
    </div>
  );
}
