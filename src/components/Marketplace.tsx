// The BOS marketplace: only bots BOS Bot publishes.
//
// The list comes from GET /api/marketplace (the hosted catalog, or the copy
// bundled into this build). "Download" is the ordinary additive import of the
// bot's package, then the recommended model when this computer offers it.
// "Request to rent" has no backend yet: the server keeps it as pending and the
// panel hands over the email to send. The owner also gets "Publish", which
// writes a catalog file to commit. A file or link still imports from the
// footer, so backups and bosbot://install links keep working.
import { ArrowLeft, Check, Copy, FileUp, Link2, Loader2, Plug, Sparkles, UploadCloud, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { track } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import {
  pickModelSelection,
  rentRequestEmail,
  slugify,
  type MarketplaceEntry,
  type MarketplaceListing,
} from "@/lib/marketplace";
import type { Routine } from "@/lib/routines";
import { teamImportPreview, type PendingTeamImport } from "@/lib/team-import";
import { api, useStore, type Bot, type Group, type ModelSelection } from "@/state/store";
import { MausAvatar } from "./Avatar";
import { MASCOT_BODY_IDS, type MascotBodyId } from "../../shared/mascot-bodies";
import { MAX_TEAM_BACKUP_BYTES } from "../../shared/team-backup";

export interface TeamImportResult {
  name: string;
  members: number;
}

type View = { kind: "list" } | { kind: "bot"; slug: string } | { kind: "publish" };

interface ImportResponse {
  bots: Bot[];
  groups?: Group[];
  routines?: Routine[];
}

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function BotMascot({ entry, size }: { entry: Pick<MarketplaceEntry, "name" | "avatar">; size: number }) {
  const body = (MASCOT_BODY_IDS as readonly string[]).includes(entry.avatar.body ?? "") ? (entry.avatar.body as MascotBodyId) : "circle";
  return <MausAvatar bodyId={body} color={entry.avatar.color as never} size={size} label={entry.name} animated={false} trackPointer={false} />;
}

const pill = "flex items-center gap-1.5 rounded-full bg-raised px-3 py-1.5 text-[12px] text-ink-secondary";
const primary =
  "flex shrink-0 items-center justify-center gap-2 rounded-full bg-accent px-5 py-2.5 text-[14px] font-medium text-white hover:bg-accent/90 disabled:opacity-60";
const secondary =
  "flex shrink-0 items-center justify-center gap-2 rounded-full border border-hairline px-5 py-2.5 text-[14px] text-ink hover:bg-raised disabled:opacity-60";
const field = "w-full rounded-lg border border-hairline bg-card px-3 py-2 text-[14px] text-ink outline-none focus:border-accent";

export function Marketplace({
  onClose,
  onImported,
  returnFocusRef,
  initialUrl,
}: {
  onClose: () => void;
  onImported: (result: TeamImportResult) => void;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
  initialUrl?: string;
}) {
  const { state, dispatch } = useStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [listing, setListing] = useState<MarketplaceListing | null>(null);
  const [loadError, setLoadError] = useState("");
  const [view, setView] = useState<View>({ kind: "list" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // rent
  const [rentNote, setRentNote] = useState("");
  const [rentSent, setRentSent] = useState<{ slug: string; text: string; to: string } | null>(null);
  const [copied, setCopied] = useState(false);
  // file or link import
  const [addOpen, setAddOpen] = useState(Boolean(initialUrl));
  const [link, setLink] = useState(initialUrl ?? "");
  const [pending, setPending] = useState<PendingTeamImport | null>(null);
  const [pendingEntry, setPendingEntry] = useState<MarketplaceEntry | null>(null);
  // publish
  const ownBots = state.bots.filter((bot) => !bot.hidden && !bot.remote);
  const [publishBotId, setPublishBotId] = useState("");
  const [publishSlug, setPublishSlug] = useState("");
  const [publishTagline, setPublishTagline] = useState("");
  const [publishCategory, setPublishCategory] = useState("Co-founder");
  const [publishDownload, setPublishDownload] = useState("Free");
  const [publishRent, setPublishRent] = useState("");
  const [publishTerms, setPublishTerms] = useState("");
  const [published, setPublished] = useState<{ file: string; bots: number; name: string } | null>(null);

  const load = useCallback(async (fresh = false) => {
    setLoadError("");
    try {
      // SAFETY: this endpoint is owned by the app and returns MarketplaceListing.
      setListing((await api(`/api/marketplace${fresh ? "?fresh=1" : ""}`)) as MarketplaceListing);
    } catch (cause) {
      setLoadError(errorText(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    dialogRef.current?.focus();
    return () => returnFocusRef.current?.focus();
  }, [returnFocusRef]);

  const back = useCallback(() => {
    setView({ kind: "list" });
    setError("");
    setRentSent(null);
    setPublished(null);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        event.stopPropagation();
        if (pending) setPending(null);
        else if (view.kind !== "list") back();
        else onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      const items = Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (!dialog || items.length === 0) return;
      const first = items[0]!;
      const last = items.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [back, busy, onClose, pending, view.kind]);

  const runImport = async (manifest: unknown): Promise<ImportResponse> => {
    // SAFETY: this endpoint is owned by the app and returns imported bots.
    const response = (await api("/api/teams/import?mode=add", { method: "POST", body: JSON.stringify(manifest) })) as ImportResponse;
    for (const bot of response.bots) dispatch({ type: "botAdded", bot });
    for (const group of response.groups ?? []) dispatch({ type: "groupPatched", group });
    for (const routine of response.routines ?? []) dispatch({ type: "routinePatched", routine });
    return response;
  };

  const download = async (entry: MarketplaceEntry) => {
    setError("");
    try {
      setPending(teamImportPreview(entry.package));
      setPendingEntry(entry);
    } catch (cause) { setError(errorText(cause)); }
  };

  const requestRent = async (entry: MarketplaceEntry) => {
    setBusy(true);
    setError("");
    try {
      await api("/api/marketplace/rent-requests", { method: "POST", body: JSON.stringify({ slug: entry.slug, note: rentNote.trim() || undefined }) });
      const mail = rentRequestEmail(entry, rentNote, listing?.catalog.publisher.contact);
      setRentSent({ slug: entry.slug, text: mail.text, to: mail.to });
      setCopied(false);
      track("marketplace_rent_requested", { slug: entry.slug });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const copyRent = async () => {
    if (!rentSent) return;
    try {
      await navigator.clipboard.writeText(rentSent.text);
      setCopied(true);
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const readFile = async (file: File) => {
    setError("");
    try {
      if (file.size > MAX_TEAM_BACKUP_BYTES) throw new Error("That file exceeds the 50 MB import limit.");
      const raw = await file.text();
      let manifest: unknown = raw;
      if (!file.name.toLowerCase().endsWith(".md")) {
        try {
          manifest = JSON.parse(raw);
        } catch {
          throw new Error("That backup or bot file is not valid JSON.");
        }
      }
      setPendingEntry(null);
      setPending(teamImportPreview(manifest));
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const loadLink = useCallback(async (url: string) => {
    if (!url.trim()) return;
    setBusy(true);
    setError("");
    try {
      setPendingEntry(null);
      setPending(teamImportPreview(await api("/api/marketplace/link", { method: "POST", body: JSON.stringify({ url: url.trim() }) })));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    // a deep link is fixed for this panel instance
    if (initialUrl) void loadLink(initialUrl);
  }, [initialUrl, loadLink]);

  const addPending = async () => {
    if (!pending) return;
    setBusy(true);
    setError("");
    try {
      const response = await runImport(pending.manifest);
      const first = response.bots.find((bot) => !bot.hidden);
      if (first) {
        if (pendingEntry) {
          const selection = pickModelSelection(pendingEntry.model, state.instances);
          if (selection) dispatch({ type: "updateBot", botId: first.id, patch: { modelSelection: { instanceId: selection.instanceId, model: selection.model, ...(selection.effort ? { effort: selection.effort as ModelSelection["effort"] } : {}) } } });
          track("marketplace_downloaded", { slug: pendingEntry.slug, model: selection ? "recommended" : "default" });
        }
        dispatch({ type: "select", id: first.id });
        if (pending.kind === "package") dispatch({ type: "toggleSettings", open: true, section: "overview" });
      }
      track("team_imported", { members: response.bots.length, source: pendingEntry ? "marketplace" : "file", mode: "add", format: pending.kind });
      onImported({ name: pending.name, members: response.bots.length });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const pickPublishBot = (id: string) => {
    setPublishBotId(id);
    const bot = ownBots.find((candidate) => candidate.id === id);
    if (!bot) return;
    if (!publishSlug) setPublishSlug(slugify(bot.name));
    if (!publishTagline) setPublishTagline((bot.title || bot.description || "").slice(0, 200));
  };

  const publish = async () => {
    setBusy(true);
    setError("");
    try {
      // SAFETY: this endpoint is owned by the app.
      const result = (await api("/api/marketplace/publish", {
        method: "POST",
        body: JSON.stringify({
          botId: publishBotId,
          slug: publishSlug.trim(),
          tagline: publishTagline.trim(),
          category: publishCategory.trim() || "Co-founder",
          price: { download: publishDownload.trim(), ...(publishRent.trim() ? { rent: publishRent.trim() } : {}) },
          terms: publishTerms.trim(),
        }),
      })) as { entry: MarketplaceEntry; file: string; bots: number };
      setPublished({ file: result.file, bots: result.bots, name: result.entry.name });
      track("marketplace_published", { bots: result.bots });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const bots = listing?.catalog.bots ?? [];
  const selected = view.kind === "bot" ? bots.find((entry) => entry.slug === view.slug) : undefined;
  const selection = selected ? pickModelSelection(selected.model, state.instances) : null;
  const title = selected ? selected.name : view.kind === "publish" ? "Publish a bot" : pending ? pending.name : "Bot marketplace";
  const subtitle = selected
    ? selected.tagline
    : view.kind === "publish"
      ? "Adds one of your bots to the BOS marketplace catalog."
      : pending
        ? `${pending.members.length} ${pending.members.length === 1 ? "bot" : "bots"} from a ${pending.kind === "backup" ? "backup" : "file or link"}`
        : `Bots published by ${listing?.catalog.publisher.name ?? "BOS Bot"}. Download one to run it yourself, or ask to rent it.`;
  const showBack = view.kind !== "list" || Boolean(pending);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px] sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="marketplace-title"
        tabIndex={-1}
        className="animate-pop-in flex h-[min(780px,calc(100dvh-2rem))] w-full max-w-[1040px] flex-col overflow-hidden rounded-[24px] border border-hairline/50 bg-panel shadow-2xl shadow-black/50 outline-none"
      >
        <header className="flex items-start justify-between gap-4 px-6 pb-3 pt-6 sm:px-8 sm:pt-7">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {showBack && (
                <button
                  onClick={() => (pending ? setPending(null) : back())}
                  disabled={busy}
                  className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
                  aria-label="Back to the marketplace"
                >
                  <ArrowLeft size={18} />
                </button>
              )}
              <h2 id="marketplace-title" className="truncate ui-page-title">{title}</h2>
            </div>
            <p className={cn("mt-1 text-[13px] text-ink-secondary", showBack && "ml-9")}>{subtitle}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {listing?.publisher && view.kind === "list" && !pending && (
              <button
                onClick={() => {
                  setView({ kind: "publish" });
                  setError("");
                }}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                <UploadCloud size={16} />
                <span>Publish</span>
              </button>
            )}
            <button
              onClick={onClose}
              disabled={busy}
              className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
              aria-label="Close bot marketplace"
            >
              <X size={21} />
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-4 sm:px-8">
          {pending ? (
            <div className="max-w-2xl">
              {pending.description && <p className="text-[14px] leading-relaxed text-ink-secondary">{pending.description}</p>}
              <ul className="mt-4 divide-y divide-hairline/35">
                {pending.members.map((member, index) => (
                  <li key={`${member.name}-${index}`} className="flex items-center gap-3 py-3">
                    <BotMascot entry={{ name: member.name, avatar: { color: member.color ?? "white", body: member.mascotBody } }} size={32} />
                    <div className="min-w-0">
                      <div className="truncate text-[14px] font-medium text-ink">{member.name}</div>
                      <div className="truncate text-[13px] text-ink-secondary">{member.title || "General assistant"}</div>
                    </div>
                  </li>
                ))}
              </ul>
              {pending.kind === "package" && <div className="mt-4 space-y-3 text-[13px] text-ink-secondary">
                <p>{pending.playbooks} playbooks · {pending.routines} routines · {pending.rooms} rooms</p>
                {pending.instructions?.map((instruction, index) => <details key={index} className="rounded-lg border border-hairline/40 p-3">
                  <summary className="cursor-pointer text-ink">{instruction.name}: standing instructions</summary>
                  <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-[12px]">{instruction.text}</pre>
                </details>)}
                {Boolean(pending.routineNames?.length) && <p>routines arrive paused: {pending.routineNames?.join(", ")}. enable each when ready.</p>}
                <div className="rounded-lg border border-hairline/40 p-3">
                  <p className="font-medium text-ink">connect your own accounts after import</p>
                  <p className="mt-1">account access and credentials are never included. open the imported bot’s overview for setup status and connection actions.</p>
                  {pending.apps.map((app, index) => <p key={index} className="mt-2">{app.label}{app.optional ? " (optional)" : " (required)"}{app.reason ? `: ${app.reason}` : ""}</p>)}
                  {pending.tools?.map((tool, index) => <p key={index} className="mt-2">{tool.label}{tool.optional ? " (optional)" : " (required)"}: {tool.reason}</p>)}
                  {pending.capabilities?.map((capability, index) => <p key={index} className="mt-2">required capability: {capability}</p>)}
                  {!pending.apps.length && !pending.tools?.length && !pending.capabilities?.length && <p className="mt-2">no connected accounts or extra tools required by this template.</p>}
                </div>
              </div>}
              {Boolean(pending.skills?.length) && (
                <p className="mt-3 text-[13px] text-ink-secondary">Skills arrive disabled: {pending.skills?.join(", ")}.</p>
              )}
              <p className="mt-3 text-[13px] text-ink-secondary">
                {pending.kind === "backup" ? t("teamImport.backupCopies") : t("teamImport.newSection", { name: pending.name })}
              </p>
            </div>
          ) : view.kind === "publish" ? (
            <div className="max-w-xl space-y-4">
              {published ? (
                <div className="rounded-xl bg-raised/45 px-4 py-3 text-[13px] leading-relaxed text-ink-secondary">
                  <div className="flex items-center gap-2 font-medium text-ink"><Check size={15} className="text-success" />{published.name} is in the catalog ({published.bots} {published.bots === 1 ? "bot" : "bots"}).</div>
                  <p className="mt-2">Written to <code className="break-all text-ink">{published.file}</code></p>
                  <p className="mt-1">There is no upload yet: commit this file as <code className="text-ink">shared/marketplace-catalog.json</code> on bos-bot main and every app picks it up within ten minutes.</p>
                </div>
              ) : (
                <>
                  <label className="block text-[13px] text-ink-secondary">
                    Bot
                    <select className={cn(field, "mt-1")} value={publishBotId} onChange={(event) => pickPublishBot(event.target.value)}>
                      <option value="">Choose one of your bots</option>
                      {ownBots.map((bot) => (
                        <option key={bot.id} value={bot.id}>{bot.name}</option>
                      ))}
                    </select>
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block text-[13px] text-ink-secondary">
                      Catalog id
                      <input className={cn(field, "mt-1")} value={publishSlug} onChange={(event) => setPublishSlug(event.target.value)} placeholder="closer" />
                    </label>
                    <label className="block text-[13px] text-ink-secondary">
                      Category
                      <input className={cn(field, "mt-1")} value={publishCategory} onChange={(event) => setPublishCategory(event.target.value)} />
                    </label>
                  </div>
                  <label className="block text-[13px] text-ink-secondary">
                    What it does
                    <input className={cn(field, "mt-1")} value={publishTagline} onChange={(event) => setPublishTagline(event.target.value)} placeholder="One line people see on the shelf" />
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block text-[13px] text-ink-secondary">
                      Download price
                      <input className={cn(field, "mt-1")} value={publishDownload} onChange={(event) => setPublishDownload(event.target.value)} />
                    </label>
                    <label className="block text-[13px] text-ink-secondary">
                      Rent price (blank: not for rent)
                      <input className={cn(field, "mt-1")} value={publishRent} onChange={(event) => setPublishRent(event.target.value)} placeholder="RM 499 / month" />
                    </label>
                  </div>
                  <label className="block text-[13px] text-ink-secondary">
                    Terms
                    <textarea className={cn(field, "mt-1 min-h-[84px]")} value={publishTerms} onChange={(event) => setPublishTerms(event.target.value)} placeholder="What a download or rent includes" />
                  </label>
                  <p className="text-[12px] text-ink-secondary">The bot's instructions, skills and model go in. Conversations, memory, connections and permissions never do.</p>
                </>
              )}
            </div>
          ) : selected ? (
            <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_280px]">
              <div className="min-w-0">
                <p className="text-[14px] leading-relaxed text-ink">{selected.summary}</p>
                <div className="mt-5 flex flex-wrap gap-2">
                  <span className={pill}><Sparkles size={13} />{selected.category}</span>
                  {selected.model && <span className={pill}>Runs on {selected.model.model}</span>}
                  {selected.package.package.skills?.entries.map((skill) => (
                    <span key={skill.name} className={pill} title={skill.description}>skill · {skill.name}</span>
                  ))}
                </div>
                {Boolean(selected.package.package.requirements?.apps?.length) && (
                  <div className="mt-6">
                    <div className="text-[12px] font-medium text-ink-secondary">Works with</div>
                    <ul className="mt-2 space-y-1.5 text-[13px] text-ink-secondary">
                      {selected.package.package.requirements?.apps?.map((app) => (
                        <li key={app.slug} className="flex items-start gap-2">
                          <Plug size={13} className="mt-0.5 shrink-0" />
                          <span><span className="text-ink">{app.label ?? app.slug}</span>{app.reason ? `: ${app.reason}` : ""}{app.optional ? " (optional)" : ""}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2 text-[12px] text-ink-secondary">Apps stay off until you connect them.</p>
                  </div>
                )}
                <div className="mt-6">
                  <div className="text-[12px] font-medium text-ink-secondary">Terms</div>
                  <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{selected.terms}</p>
                </div>
              </div>
              <aside className="space-y-4">
                <div className="flex items-center gap-3">
                  <BotMascot entry={selected} size={56} />
                  <div className="text-[13px] text-ink-secondary">by {listing?.catalog.publisher.name ?? "BOS Bot"}</div>
                </div>
                <div className="rounded-xl border border-hairline px-4 py-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[13px] text-ink-secondary">Download</span>
                    <span className="text-[14px] font-medium text-ink">{selected.price.download}</span>
                  </div>
                  <p className="mt-1 text-[12px] text-ink-secondary">
                    {selected.model
                      ? selection
                        ? `Set up on ${selection.label}.`
                        : `Recommended model ${selected.model.model} is not on this computer; your default model is used.`
                      : "Uses your default model."}
                  </p>
                  <button onClick={() => void download(selected)} disabled={busy} className={cn(primary, "mt-3 w-full")}>
                    {busy && !rentSent ? <Loader2 size={15} className="animate-spin" /> : null}
                    Download
                  </button>
                </div>
                {selected.price.rent && (
                  <div className="rounded-xl border border-hairline px-4 py-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[13px] text-ink-secondary">Rent</span>
                      <span className="text-[14px] font-medium text-ink">{selected.price.rent}</span>
                    </div>
                    {rentSent?.slug === selected.slug ? (
                      <div className="mt-2 text-[12px] leading-relaxed text-ink-secondary">
                        <p>Saved as pending. There is no rent backend yet, so send this request to <span className="text-ink">{rentSent.to}</span>.</p>
                        <button onClick={() => void copyRent()} className={cn(secondary, "mt-2 w-full")}>
                          {copied ? <Check size={15} /> : <Copy size={15} />}
                          {copied ? "Copied" : "Copy request"}
                        </button>
                      </div>
                    ) : (
                      <>
                        <textarea
                          className={cn(field, "mt-2 min-h-[64px] text-[13px]")}
                          value={rentNote}
                          onChange={(event) => setRentNote(event.target.value)}
                          placeholder="What you need it for (optional)"
                        />
                        <button onClick={() => void requestRent(selected)} disabled={busy} className={cn(secondary, "mt-2 w-full")}>
                          Request to rent
                        </button>
                      </>
                    )}
                  </div>
                )}
              </aside>
            </div>
          ) : (
            <>
              {!listing && !loadError && (
                <div className="flex items-center gap-2 py-10 text-[13px] text-ink-secondary"><Loader2 size={15} className="animate-spin" />Loading the marketplace…</div>
              )}
              {loadError && (
                <div role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-[13px] text-danger">
                  {loadError} <button className="underline" onClick={() => void load(true)}>Try again</button>
                </div>
              )}
              {listing?.source === "bundled" && (
                <p className="mb-3 text-[12px] text-ink-secondary">
                  Showing the list built into this version{listing.error ? "; the live catalog could not be reached" : ""}.
                </p>
              )}
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {bots.map((entry) => (
                  <button
                    key={entry.slug}
                    onClick={() => {
                      setView({ kind: "bot", slug: entry.slug });
                      setError("");
                      setRentNote("");
                    }}
                    className="flex items-start gap-4 rounded-2xl border border-hairline/60 bg-card/40 px-4 py-4 text-left hover:border-hairline hover:bg-raised/40"
                  >
                    <BotMascot entry={entry} size={48} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-[15px] font-medium text-ink">{entry.name}</span>
                        <span className="shrink-0 text-[12px] text-ink-secondary">{entry.category}</span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-ink-secondary">{entry.tagline}</p>
                      <div className="mt-2 flex flex-wrap gap-x-3 text-[12px] text-ink">
                        <span>Download · {entry.price.download}</span>
                        {entry.price.rent && <span>Rent · {entry.price.rent}</span>}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
              {listing && bots.length === 0 && <p className="py-10 text-[13px] text-ink-secondary">Nothing is published yet.</p>}
            </>
          )}
          {error && <div role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-[13px] text-danger">{error}</div>}
        </div>

        <footer className="flex flex-col gap-3 border-t border-hairline/35 px-6 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          {pending ? (
            <>
              <span className="text-[13px] text-ink-secondary">Your existing bots and conversations stay unchanged.</span>
              <button onClick={() => void addPending()} disabled={busy} className={primary}>
                {busy && <Loader2 size={15} className="animate-spin" />}
                {pending.kind === "backup" ? "Import backup" : "Add"}
              </button>
            </>
          ) : view.kind === "publish" ? (
            <>
              <span className="text-[13px] text-ink-secondary">Only you see Publish.</span>
              {!published && (
                <button
                  onClick={() => void publish()}
                  disabled={busy || !publishBotId || !publishSlug.trim() || !publishTagline.trim() || !publishDownload.trim() || !publishTerms.trim()}
                  className={primary}
                >
                  {busy && <Loader2 size={15} className="animate-spin" />}
                  Publish
                </button>
              )}
            </>
          ) : addOpen ? (
            <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center">
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,.md,application/json,text/markdown"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void readFile(file);
                }}
              />
              <button onClick={() => fileInputRef.current?.click()} className={secondary}>
                <FileUp size={15} />
                Choose file
              </button>
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <input
                  className={field}
                  value={link}
                  onChange={(event) => setLink(event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && void loadLink(link)}
                  placeholder="https://github.com/… bot or team link"
                  aria-label="Bot or team link"
                />
                <button onClick={() => void loadLink(link)} disabled={busy || !link.trim()} className={secondary}>
                  {busy ? <Loader2 size={15} className="animate-spin" /> : <Link2 size={15} />}
                  Open
                </button>
              </div>
            </div>
          ) : (
            <>
              <span className="text-[13px] text-ink-secondary">Have a bot file, a backup or a link?</span>
              <button onClick={() => setAddOpen(true)} className="text-[13px] text-ink-secondary underline-offset-2 hover:text-ink hover:underline">
                Add from a file or link
              </button>
            </>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
