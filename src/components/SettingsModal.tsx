// App settings, as a real modal with sections rather than one long panel.
// Per-bot settings (persona, model, computer) live in BotSettingsDialog — this
// is the stuff shared by every bot: who you are, your keys, and the
// machine your bots can borrow.
import { useEffect, useRef, useState } from "react";
import { Archive, Coins, Download, KeyRound, RefreshCw, Search, TabletSmartphone, Terminal, User, Users, X, Building2 } from "lucide-react";
import { api, useStore, type AppSettingsSection, type ConfigStatus } from "@/state/store";
import { analyticsEnabled, setAnalyticsEnabled } from "@/lib/analytics";
import { localeChoices, type LocaleKey } from "@/locales";
import { t } from "@/lib/i18n";
import { ApiKeyRow, VpsConnection } from "./ApiKeys";
import { useUpdaterState } from "@/lib/updater";
import { EnginesSettings } from "./EnginesSettings";
import { CompanionSection } from "./CompanionSection";
import { LinkedServersCard } from "./LinkedServersCard";
import { ServerPairingCard } from "./ServerPairingCard";
import { PeopleSection } from "./PeopleSection";
import { StaffLoginsSection } from "./StaffLoginsSection";
import { RemovedRemoteBots } from "./RemovedRemoteBots";
import { RemoteComputerSection } from "./RemoteComputerSection";
import { ConnectedWorkspacesSettings } from "./ConnectedWorkspacesSettings";
import { Card, SettingRow, Switch } from "./SettingsPrimitives";
import { shortcutLabel } from "./ShortcutHint";
import { UsageSection } from "./UsageSection";
import { SetupImportSettings } from "./SetupImport";
import { UpdatesSettings } from "./BosUpdate";
import { WorkspacesSection, workspacesAvailable } from "./WorkspacesSection";
import { SkinPicker } from "./SkinPicker";
import { AnonymousUsageSettings } from "./AnonymousUsageSettings";
import { DefaultApprovalsSettings } from "./DefaultApprovalsSettings";
import { AttentionSettings } from "./AttentionSettings";
import { ApprovalRulesSettings } from "./ApprovalRulesSettings";
import { WorkspaceBackupSettings } from "./WorkspaceBackupSettings";
import { CompanyBackupSettings } from "./CompanyBackupSettings";
import { InitialsAvatar, PersonPhoto } from "./Avatar";
import { profileInitials } from "./SidebarProfileMenu";
import { prepareProfilePhoto, saveProfileField, saveProfilePhoto } from "@/lib/profile-photo";
import { cn } from "@/lib/cn";
import { setShowThreads, useShowThreads } from "@/lib/thread-preferences";

// `labelKey`, not a label: t() reads the active pack when it is called, so a
// label resolved here at module scope would freeze the language the app booted
// in. The English keywords stay untranslated — they are a search index, and a
// pack that omits them still matches what people type.
const SECTIONS: Array<{
  id: AppSettingsSection;
  labelKey: LocaleKey;
  icon: typeof User;
  keywords: string[];
  /** Kept off the nav and out of search; opened only by a deep link (the
   * desktop Server menu), and listed while it is the open page. */
  hidden?: boolean;
}> = [
  { id: "general", labelKey: "settings.section.general", icon: User, keywords: ["profile", "name", "email", "photo", "language", "skin", "theme", "appearance", "display", "threads", "show threads", "hide threads", "permissions", "approval", "access", "full access", "privacy", "analytics"] },
  { id: "updates", labelKey: "settings.section.updates", icon: RefreshCw, keywords: ["update", "updates", "restart", "version", "build", "relaunch", "rollback"] },
  { id: "desktopWorkspaces", labelKey: "settings.section.desktopWorkspaces", icon: Building2, keywords: ["workspace", "cloud", "hosted", "vps", "server", "connect", "pair", "switch", "local"], hidden: true },
  { id: "import", labelKey: "settings.section.import", icon: Download, keywords: ["import", "claude code", "codex", "cursor", "claude.md", "agents.md", "skills", "mcp", "sync", "bring your setup", "migrate"] },
  { id: "connections", labelKey: "settings.section.connections", icon: KeyRound, keywords: ["apps", "composio", "box", "vps", "opencode"] },
  { id: "engines", labelKey: "settings.section.engines", icon: Terminal, keywords: ["models", "add a model", "api key", "keys", "claude", "codex", "openai", "anthropic", "gemini", "xai", "grok", "openrouter", "deepseek", "providers"] },
  { id: "companion", labelKey: "settings.section.companion", icon: TabletSmartphone, keywords: ["companion", "device", "phone", "desktop", "computer", "pair", "pairing", "mobile", "qr", "remote", "connect"] },
  { id: "usage", labelKey: "settings.section.usage", icon: Coins, keywords: ["tokens", "cost", "billing"] },
  { id: "people", labelKey: "settings.section.people", icon: Users, keywords: ["people", "users", "invite", "sign in", "members", "admins", "access"] },
  { id: "backups", labelKey: "settings.section.backups", icon: Archive, keywords: ["export", "import", "restore", "full backup", "password", "recovery"] },
  { id: "workspaces", labelKey: "settings.section.workspaces", icon: Building2, keywords: ["clients", "tenants", "fleet", "workspaces"] },
];

function sectionMatches(section: (typeof SECTIONS)[number], query: string): boolean {
  if (!query) return true;
  return [t(section.labelKey), ...section.keywords].some((part) => part.toLowerCase().includes(query));
}

/** Owner details and photo, saved without overwriting other profile members. */
export function ProfileFields() {
  const { state, dispatch } = useStore();
  const configRef = useRef(state.config);
  configRef.current = state.config;
  const fileRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(state.config?.profile?.name ?? "");
  const [email, setEmail] = useState(state.config?.profile?.email ?? "");
  useEffect(() => { setName(state.config?.profile?.name ?? ""); }, [state.config?.profile?.name]);
  useEffect(() => { setEmail(state.config?.profile?.email ?? ""); }, [state.config?.profile?.email]);

  const run = async (work: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try { await work(); }
    catch (failure) { setError(t("settings.profile.saveError", { message: failure instanceof Error ? failure.message : String(failure) })); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const save = (field: "name" | "email", value: string) => run(async () => {
    const config = await saveProfileField(field, value);
    configRef.current = config;
    dispatch({ type: "configStatus", config });
  });
  const photo = (file: File | null) => run(async () => {
    try {
      const encoded = file ? await prepareProfilePhoto(file) : null;
      const avatarUrl = await saveProfilePhoto(encoded);
      const current = configRef.current;
      if (current) {
        const config = { ...current, profile: { name: "", email: "", ...current.profile, avatarUrl } };
        configRef.current = config;
        dispatch({ type: "configStatus", config });
      }
    } finally { if (fileRef.current) fileRef.current.value = ""; }
  });
  const avatarUrl = state.config?.profile?.avatarUrl;
  const inputClass = "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";
  return (
    <div className="flex flex-col gap-3" aria-busy={busy}>
      <div className="flex items-center gap-3">
        <div role="img" aria-label={t("settings.profile.photo")}>
          {avatarUrl ? <PersonPhoto src={avatarUrl} size={56} /> : <InitialsAvatar initials={profileInitials(state.config?.profile)} size={56} />}
        </div>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" aria-label={t("settings.profile.choosePhoto")} disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void photo(file); }} />
        <button type="button" className="ui-button" disabled={busy} onClick={() => fileRef.current?.click()}>{t("settings.profile.choosePhoto")}</button>
        {avatarUrl && <button type="button" className="ui-button" disabled={busy} onClick={() => void photo(null)}>{t("settings.profile.removePhoto")}</button>}
        {busy && <span role="status" className="text-sm text-ink-secondary">{t("settings.profile.saving")}</span>}
      </div>
      <input aria-label={t("settings.profile.name")} disabled={busy} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => { if (name.trim() !== (configRef.current?.profile?.name ?? "")) void save("name", name); }} placeholder={t("settings.profile.name")} className={inputClass} />
      <input type="email" aria-label={t("phone.signIn.email")} disabled={busy} value={email} onChange={(e) => setEmail(e.target.value)} onBlur={() => { if (email.trim().toLowerCase() !== (configRef.current?.profile?.email ?? "")) void save("email", email); }} placeholder="you@example.com" className={inputClass} />
      {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    </div>
  );
}

function UpdatesRow() {
  const s = useUpdaterState();
  if (!window.ogb?.updater) return null;
  const updater = window.ogb.updater;
  // BOS's own updater above owns the everyday check; the desktop shell's
  // row appears only while it has something to say.
  if (!s || s.status === "idle") return null;
  const label =
    s?.status === "checking"
      ? t("settings.updates.checking")
      : s?.status === "available"
        ? t("settings.updates.available", { version: s.version ?? "" })
        : s?.status === "downloading"
          ? s.percent == null
            ? t("settings.updates.startingDownload")
            : t("settings.updates.downloading", { percent: Math.round(s.percent) })
          : s?.status === "preparing"
            ? t("settings.updates.preparing")
            : s?.status === "downloaded"
              ? s.installMode === "handoff"
                ? t("settings.updates.readyInstall", { version: s.version ?? "" })
                : t("settings.updates.ready", { version: s.version ?? "" })
              : s?.status === "installing"
                ? s.message ||
                  (s.installMode === "handoff"
                    ? t("settings.updates.openingTerminal")
                    : t("settings.updates.restarting"))
                : s?.status === "handed-off"
                  ? t("settings.updates.handedOff")
                  : s?.status === "error"
                    ? t("settings.updates.failed", { message: s.message ?? t("settings.updates.unknownError") })
                    : "";
  return (
    <SettingRow title={t("settings.updates.title")} subtitle={label}>
      <button
        onClick={() => {
          if (s?.status === "available") return void updater.download();
          if (s?.status === "downloaded") return void updater.install();
          void updater.check();
        }}
        disabled={
          s?.status === "checking" || s?.status === "downloading" || s?.status === "preparing" ||
          s?.status === "installing" || s?.retryable === false
        }
        className="ui-button"
      >
        {s?.retryable === false
          ? t("settings.updates.quitReopen")
          : s?.status === "available"
            ? t("settings.updates.download")
            : s?.status === "downloaded"
              ? s.installMode === "handoff"
                ? t("settings.updates.install")
                : t("settings.updates.restart")
              : s?.status === "preparing"
                ? t("settings.updates.preparingShort")
                : s?.status === "installing"
                  ? s.installMode === "handoff"
                    ? t("settings.updates.opening")
                    : t("settings.updates.restartingShort")
                  : t("settings.updates.check")}
      </button>
    </SettingRow>
  );
}

/** Usage analytics, on by default and switchable here. Naming what is sent
 * matters more than the switch: people who cannot see the scope assume the
 * worst, and the worst — conversation text — is exactly what this never
 * sends (autocapture is off; see lib/analytics.ts). */
function AnalyticsRow() {
  const [on, setOn] = useState(analyticsEnabled);
  return (
    <SettingRow title={t("settings.analytics.title")} subtitle={t("settings.analytics.subtitle")}>
      <Switch
        checked={on}
        aria-label={t("settings.analytics.aria")}
        onClick={() => {
          const next = !on;
          setAnalyticsEnabled(next);
          setOn(next);
        }}
      />
    </SettingRow>
  );
}

function LanguageRow() {
  const { state, dispatch } = useStore();
  const current = state.config?.language ?? "";
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async (language: string) => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ language }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.language.error"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow
      title={t("settings.language.title")}
      subtitle={t("settings.language.subtitle")}
      message={error ? <p role="alert" className="text-danger">{error}</p> : null}
    >
      <select
        value={current}
        disabled={saving}
        aria-label={t("settings.language.aria")}
        onChange={(event) => void save(event.target.value)}
        className="min-h-8 w-full max-w-[240px] rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[13px] text-ink focus:border-focus disabled:cursor-wait disabled:opacity-50"
      >
        <option value="">{t("settings.language.system")}</option>
        {localeChoices.map(({ code, label }) => (
          <option key={code} value={code}>
            {label}
          </option>
        ))}
      </select>
    </SettingRow>
  );
}

function ShowThreadsRow() {
  const enabled = useShowThreads();
  return (
    <SettingRow title={t("settings.threadDisplay.title")} subtitle={t("settings.threadDisplay.subtitle")}>
      <Switch
        checked={enabled}
        aria-label={t("settings.threadDisplay.show")}
        onClick={() => setShowThreads(!enabled)}
      />
    </SettingRow>
  );
}

export function SettingsModal() {
  const { state, dispatch } = useStore();
  const remoteActive = window.ogb?.remoteClient?.active === true;
  const section: AppSettingsSection =
    (remoteActive && !["general", "appearance", "desktopWorkspaces"].includes(state.appSettingsSection)) || state.appSettingsSection === "remote"
      ? "companion"
      // Appearance folded into General; old deep links still land there.
      : state.appSettingsSection === "appearance" ? "general" : state.appSettingsSection;
  const dialogRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  useEffect(() => window.ogb?.environments?.onOpenSettings?.(() => setQuery("")), []);
  const q = query.trim().toLowerCase();
  const availableSections = SECTIONS.filter((entry) => !entry.hidden || entry.id === section)
    .filter((entry) => !remoteActive || entry.id === "companion" || entry.id === "general" || entry.id === "desktopWorkspaces")
    .filter((entry) => entry.id !== "desktopWorkspaces" || Boolean(window.ogb?.environments))
    // the operator's screen for other workspaces exists only where a fleet agent does
    .filter((entry) => entry.id !== "workspaces" || workspacesAvailable(state.config));
  const visibleSections = availableSections.filter((entry) => sectionMatches(entry, q));
  const sectionLabelKey = SECTIONS.find((entry) => entry.id === section)?.labelKey;
  const nextVisibleSection = visibleSections.some((entry) => entry.id === section) ? undefined : visibleSections[0]?.id;

  useEffect(() => {
    // Translated matches can change without the query changing. Follow the
    // rendered results instead of a second filter with stale effect inputs.
    if (nextVisibleSection) dispatch({ type: "toggleAppSettings", open: true, section: nextVisibleSection });
  }, [dispatch, nextVisibleSection]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const search = dialog?.querySelector<HTMLInputElement>("[data-settings-search]");
    if (search?.checkVisibility()) search.focus();
    else dialog?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dispatch({ type: "toggleAppSettings", open: false });
        return;
      }
      if (event.key !== "Tab" || !dialog) return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.checkVisibility());
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [dispatch]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-6"
      onMouseDown={(e) => e.target === e.currentTarget && dispatch({ type: "toggleAppSettings", open: false })}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-settings-title"
        tabIndex={-1}
        className={cn("settings-dialog animate-pop-in flex max-h-[calc(100dvh-24px)] w-full overflow-hidden rounded-[26px] border border-hairline/40 bg-panel shadow-[0_24px_80px_rgba(0,0,0,0.55)] outline-none", section === "engines" ? "h-[760px] max-w-[1080px]" : "h-[680px] max-w-[980px]")}
      >
        {/* section nav */}
        <span id="app-settings-title" className="sr-only">{t("settings.title")}</span>
        <nav className="hidden min-h-0 w-[232px] shrink-0 flex-col gap-0.5 overflow-y-auto bg-app/40 px-3 pb-3 pt-4 sm:flex">
          <div className="shrink-0 px-3 pb-3 pt-1 text-[17px] font-semibold text-ink">
            {t("settings.title")}
          </div>
          <div className="mb-3 flex h-10 shrink-0 items-center gap-2 rounded-full border border-hairline/40 bg-raised/60 px-3.5 focus-within:border-hairline">
            <Search size={14} className="shrink-0 text-ink-secondary" />
            <input
              data-settings-search
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.stopPropagation();
                if (query) setQuery("");
                else dispatch({ type: "toggleAppSettings", open: false });
              }}
              placeholder={t("settings.search")}
              aria-label={t("settings.searchAria")}
              className="w-full bg-transparent text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
            />
          </div>
          {visibleSections.length === 0 && (
            <div className="px-2.5 py-4 text-[13px] leading-relaxed text-ink-secondary">
              {t("settings.noMatch", { query: query.trim() })}
            </div>
          )}
          {visibleSections.map(({ id, labelKey, icon: Icon }) => (
            <button
              key={id}
              onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: id })}
              aria-current={section === id ? "page" : undefined}
              className={cn(
                "flex min-h-10 items-center gap-3 rounded-xl px-3 py-2 text-start text-[14px] transition-colors motion-reduce:transition-none",
                section === id ? "bg-raised-hover font-medium text-ink" : "text-ink-secondary hover:bg-raised/70 hover:text-ink",
              )}
            >
              <Icon size={17} className="shrink-0" />
              {t(labelKey)}
            </button>
          ))}
        </nav>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between gap-3 px-3 pb-2 pt-3 sm:px-8 sm:pt-6">
            <select
              aria-label={t("settings.title")}
              value={section}
              onChange={(event) => {
                setQuery("");
                dispatch({ type: "toggleAppSettings", open: true, section: event.target.value as AppSettingsSection });
              }}
              className="min-w-0 rounded-lg bg-control px-3 py-2 text-[14px] text-ink sm:hidden"
            >
              {availableSections.map(({ id, labelKey }) => (
                <option key={id} value={id}>{t(labelKey)}</option>
              ))}
            </select>
            <span className="hidden text-[26px] font-semibold tracking-[-0.01em] text-ink sm:block">
              {sectionLabelKey ? t(sectionLabelKey) : null}
            </span>
            <button
              onClick={() => dispatch({ type: "toggleAppSettings", open: false })}
              aria-label={t("settings.close")}
              title={`${t("settings.close")} (${shortcutLabel("close-panel")})`}
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink"
            >
              <X size={18} />
            </button>
          </div>

          <div className="settings-pane flex flex-1 flex-col gap-6 overflow-y-auto px-3 py-4 sm:px-8 sm:pb-8">
            {section === "desktopWorkspaces" && (
              <>
                <ConnectedWorkspacesSettings />
                {/* the technical pairing tools live with the servers they talk to:
                    this desktop as a client of another BOS, another server's bots
                    in this sidebar, and session codes for MCP clients or
                    `bosbot pair` (#950). Devices pair under Connect a device. */}
                {!remoteActive && <RemoteComputerSection />}
                {!remoteActive && <LinkedServersCard />}
                {!remoteActive && <ServerPairingCard />}
              </>
            )}
            {section === "general" && (
              <>
                {!remoteActive && (
                  <Card title={t("settings.profile.title")} subtitle={t("settings.profile.subtitle")}>
                    <ProfileFields />
                  </Card>
                )}
                {!remoteActive && <Card title="Digital marketer" subtitle="Private setup with your own AI provider. Account connections are optional for your first plan; checkout is not available yet.">
                  <button className="rounded-xl border border-hairline px-4 py-2 text-sm text-ink hover:bg-panel-hover" onClick={() => {
                    dispatch({ type: "toggleAppSettings", open: false });
                    window.dispatchEvent(new Event("bos:setup-marketer"));
                  }}>Set up digital marketer</button>
                </Card>}
                <Card title={t("settings.skin.title")} subtitle={t("settings.skin.subtitle")}>
                  <SkinPicker />
                </Card>
                <div>
                  <ShowThreadsRow />
                  {!remoteActive && <LanguageRow />}
                </div>
                <AttentionSettings />
                {!remoteActive && <ApprovalRulesSettings />}
                {!remoteActive && (
                  <>
                    <DefaultApprovalsSettings />
                    <RemovedRemoteBots />
                    <details className="rounded-xl border border-hairline/40 px-4 py-3">
                      <summary className="cursor-pointer text-[13px] text-ink-secondary hover:text-ink">{t("settings.privacy.title")}</summary>
                      <div className="mt-2">
                        <AnalyticsRow />
                        <AnonymousUsageSettings />
                      </div>
                    </details>
                  </>
                )}
              </>
            )}

            {section === "connections" && (
              <Card
                title={t("settings.connections.title")}
                subtitle={t("settings.connections.subtitle")}
              >
                <div className="flex flex-col gap-4">
                  {state.config?.composio.mode === "managed" ? (
                    <div className="rounded-lg border border-success/25 bg-success/10 px-3 py-2 text-[13px] text-success">
                      {t("settings.connections.ready")}
                    </div>
                  ) : null}
                  {/* Without a managed service the Composio key is how apps
                      connect at all, so it leads instead of being tucked away. */}
                  {state.config?.composio.mode !== "managed" && <ApiKeyRow section="composio" />}
                  <ApiKeyRow section="box" />
                  <ApiKeyRow section="boxCompute" />
                  <VpsConnection />
                  <ApiKeyRow section="opencodeGo" />
                  {state.config?.composio.mode === "managed" && (
                    <details className="rounded-lg border border-hairline/40 bg-inset px-3 py-2">
                      <summary className="cursor-pointer text-[13px] text-ink-secondary">{t("settings.connections.selfHost")}</summary>
                      <div className="mt-3">
                        <ApiKeyRow section="composio" />
                      </div>
                    </details>
                  )}
                </div>
              </Card>
            )}

            {section === "engines" && (
              <EnginesSettings />
            )}

            {section === "backups" && <><WorkspaceBackupSettings /><CompanyBackupSettings />
              <Card title="cloud and managed bos">
                <p className="mb-3 text-sm text-ink-secondary">keep bos on your computer for free, or see the cloud and managed options. your ai subscription stays separate.</p>
                <a className="text-sm text-ink underline" href="https://bosbot.my/#pricing" target="_blank" rel="noopener noreferrer">view plans</a>
              </Card>
            </>}

            {section === "companion" && (
              <>
                {/* a remote client's only way back to its own computer */}
                {remoteActive && <RemoteComputerSection />}
                {/* One way to connect. The desktop app pairs through its own
                    companion flow (sign in once, scan a QR). A browser on a hosted
                    server, or this desktop as a remote client of one, pairs with
                    that server's one-time code instead: its requests carry the
                    server's session, and the server decides who may act (MOCA-84). */}
                {window.ogb && "companion" in window.ogb && !!window.ogb.companion && !remoteActive
                  ? <CompanionSection profileEmail={state.config?.profile?.email} />
                  : <ServerPairingCard />}
              </>
            )}

            {section === "updates" && (
              <>
                <UpdatesSettings />
                <div>
                  <UpdatesRow />
                </div>
              </>
            )}

            {section === "import" && <SetupImportSettings />}
            {section === "usage" && <UsageSection />}
            {section === "people" && <>{!window.ogb && <PeopleSection />}<StaffLoginsSection /></>}
            {section === "workspaces" && <WorkspacesSection />}
          </div>
        </div>
      </div>
    </div>
  );
}
