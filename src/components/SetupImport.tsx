// "Bring your setup": import an existing Claude Code, Codex or Cursor setup
// into a bot. Shown in settings > import and as an onboarding beat. The
// server detects (server/setup-import.ts) and never sends a secret value:
// MCP servers arrive with env and header NAMES and a needs-sign-in flag.
//
// source -> bot -> what to bring -> preview -> import -> result
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, FolderOpen, KeyRound, RefreshCw, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { api, useStore, type Bot } from "@/state/store";
import { Card, SettingRow, Switch } from "./SettingsPrimitives";

type SourceId = "claude" | "codex" | "cursor";

export interface DetectedSkill {
  name: string;
  description: string;
  path: string;
  error?: string;
  warnings: string[];
  supportFiles: number;
}

export interface DetectedMcpServer {
  id: string;
  name: string;
  originalName: string;
  scope: string;
  transport: "stdio" | "http" | "sse";
  target: string;
  envKeys: string[];
  headerKeys: string[];
  needsSignIn: boolean;
  signInReasons: string[];
  disabledInSource: boolean;
  error?: string;
}

export interface DetectedSource {
  id: SourceId;
  label: string;
  home: string;
  found: boolean;
  instructions: { files: string[]; bytes: number; preview: string; expanded: boolean; tooLong: boolean } | null;
  skills: DetectedSkill[];
  mcpServers: DetectedMcpServer[];
  projects: Array<{ path: string; name: string }>;
  extras: { hooks: number; plugins: number; agents: number; commands: number; settings: boolean };
}

interface SyncLinkView {
  id: string;
  source: SourceId;
  botId: string;
  sync: boolean;
  updatedAt: string;
  lastCheckedAt: string | null;
  instructions: { mode: "replace" | "append"; files: string[]; diverged: boolean } | null;
  skills: string[];
  conflicts: Array<{ kind: "instructions" | "skill"; name: string; at: string; reason: string }>;
}

interface ItemResult {
  name: string;
  ok: boolean;
  enabled?: boolean;
  message: string;
}

interface ApplyResult {
  instructions: ItemResult | null;
  skills: ItemResult[];
  mcpServers: ItemResult[];
  project: ItemResult | null;
  link: SyncLinkView | null;
}

interface DetectResponse {
  sources: DetectedSource[];
  links: SyncLinkView[];
}

/** Something worth offering: a found setup with at least one importable part. */
export function hasImportable(source: DetectedSource): boolean {
  return source.found && Boolean(source.instructions || source.skills.length || source.mcpServers.length || source.projects.length);
}

export async function detectSetups(): Promise<DetectResponse> {
  return api<DetectResponse>("/api/setup-import");
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function sourceSummary(source: DetectedSource): string {
  const parts: string[] = [];
  if (source.instructions) parts.push("instructions");
  if (source.skills.length) parts.push(plural(source.skills.length, "skill"));
  if (source.mcpServers.length) parts.push(plural(source.mcpServers.length, "mcp server"));
  if (source.projects.length) parts.push(plural(source.projects.length, "project"));
  return parts.join(" · ") || "nothing to import";
}

function leftOut(source: DetectedSource): string {
  const parts: string[] = [];
  if (source.extras.hooks) parts.push(plural(source.extras.hooks, "hook"));
  if (source.extras.plugins) parts.push(plural(source.extras.plugins, "plugin"));
  if (source.extras.agents) parts.push(plural(source.extras.agents, "subagent"));
  if (source.extras.commands) parts.push(plural(source.extras.commands, "command"));
  if (source.extras.settings) parts.push("model and permission settings");
  parts.push("chat history");
  return parts.join(", ");
}

const row = "flex items-start gap-3 rounded-lg px-3 py-2.5 text-left";
const label = "text-[12px] font-medium uppercase tracking-wide text-ink-secondary";
const quiet = "rounded-lg px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40";
const primary = "rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-accent-ink disabled:opacity-40";

function Checkbox({ checked, disabled, onChange, title }: { checked: boolean; disabled?: boolean; onChange: (next: boolean) => void; title: string }) {
  return (
    <input
      type="checkbox"
      aria-label={title}
      className="mt-0.5 size-4 shrink-0 accent-accent disabled:opacity-40"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

function Section({ title, count, children, action }: { title: string; count?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between px-1">
        <div className={label}>{title}{count ? <span className="ml-2 normal-case tracking-normal">{count}</span> : null}</div>
        {action}
      </div>
      <div className="flex flex-col divide-y divide-hairline/25 overflow-hidden rounded-xl border border-hairline/40 bg-inset">{children}</div>
    </div>
  );
}

type Step = "source" | "bot" | "pick" | "preview" | "done";

export function SetupImportFlow({
  initial,
  defaultBotId,
  compact = false,
  onFinished,
  onLinksChanged,
}: {
  /** Detection already fetched by the caller (onboarding). */
  initial?: DetectResponse | null;
  /** Preselected target (onboarding's seeded bot). */
  defaultBotId?: string | null;
  /** Onboarding: no back to source when there is only one. */
  compact?: boolean;
  onFinished?: () => void;
  onLinksChanged?: () => void;
}) {
  const { state, dispatch } = useStore();
  const [data, setData] = useState<DetectResponse | null>(initial ?? null);
  const [error, setError] = useState("");
  const [step, setStep] = useState<Step>("source");
  const [sourceId, setSourceId] = useState<SourceId | null>(null);
  const [botId, setBotId] = useState<string>(defaultBotId ?? "");
  const [newBotName, setNewBotName] = useState("");
  const [creating, setCreating] = useState(false);
  const [instructions, setInstructions] = useState(false);
  const [mode, setMode] = useState<"replace" | "append">("append");
  const [skills, setSkills] = useState<Set<string>>(new Set());
  const [servers, setServers] = useState<Set<string>>(new Set());
  const [project, setProject] = useState<string | null>(null);
  const [sync, setSync] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ApplyResult | null>(null);

  useEffect(() => {
    if (initial) return;
    let live = true;
    detectSetups()
      .then((next) => live && setData(next))
      .catch((err) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [initial]);

  const bots = useMemo(() => state.bots.filter((bot) => !bot.remote && !bot.homeLink), [state.bots]);
  const importable = data?.sources.filter(hasImportable) ?? [];
  const source = data?.sources.find((candidate) => candidate.id === sourceId) ?? null;
  const target: Bot | undefined = bots.find((bot) => bot.id === botId);

  // One setup found in onboarding: start on it.
  useEffect(() => {
    if (compact && !sourceId && importable.length === 1) choose(importable[0]!.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compact, importable.length]);

  function choose(id: SourceId) {
    const next = data?.sources.find((candidate) => candidate.id === id);
    if (!next) return;
    setSourceId(id);
    setInstructions(Boolean(next.instructions && !next.instructions.tooLong));
    setSkills(new Set(next.skills.filter((skill) => !skill.error).map((skill) => skill.name)));
    // user-wide servers by default; project ones are opt-in so the 20-server
    // registry is not filled with every repo's tools
    setServers(new Set(next.mcpServers.filter((server) => !server.error && server.scope === "user").map((server) => server.id)));
    setProject(null);
    setResult(null);
    setError("");
    setStep(defaultBotId && bots.some((bot) => bot.id === defaultBotId) ? "pick" : "bot");
  }

  useEffect(() => {
    if (target) setMode(target.soul?.trim() ? "append" : "replace");
  }, [target?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function createBot() {
    const name = newBotName.trim();
    if (!name) return;
    setCreating(true);
    setError("");
    try {
      const { bot } = await api<{ bot: Bot }>("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
      dispatch({ type: "botAdded", bot });
      setBotId(bot.id);
      setNewBotName("");
      setStep("pick");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function runImport() {
    if (!source || !target) return;
    setBusy(true);
    setError("");
    try {
      const next = await api<ApplyResult>("/api/setup-import/apply", {
        method: "POST",
        body: JSON.stringify({
          source: source.id,
          botId: target.id,
          instructions: instructions ? { mode } : null,
          skills: [...skills],
          mcpServers: [...servers],
          project,
          sync,
        }),
      });
      setResult(next);
      setStep("done");
      onLinksChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const toggle = (set: Set<string>, key: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(key);
    else next.delete(key);
    return next;
  };

  if (!data) {
    return error
      ? <div role="alert" className="text-[12.5px] text-danger">{error}</div>
      : <div className="text-[12.5px] text-ink-secondary">looking for claude code, codex and cursor on this computer…</div>;
  }

  const pickedServers = source?.mcpServers.filter((server) => servers.has(server.id)) ?? [];
  const nothingPicked = !instructions && !skills.size && !servers.size && !project;
  const backButton = (to: Step) => (
    <button type="button" className={cn(quiet, "flex items-center gap-1.5")} onClick={() => setStep(to)}>
      <ArrowLeft size={14} /> back
    </button>
  );

  return (
    <div className="flex flex-col gap-4">
      {step === "source" && (
        <div className="flex flex-col gap-2">
          {data.sources.map((candidate) => {
            const ok = hasImportable(candidate);
            return (
              <button
                key={candidate.id}
                type="button"
                disabled={!ok}
                onClick={() => choose(candidate.id)}
                className={cn(
                  "flex items-center justify-between gap-3 rounded-xl border border-hairline/40 bg-card px-4 py-3 text-left",
                  ok ? "hover:bg-raised-hover" : "opacity-50",
                )}
              >
                <div className="min-w-0">
                  <div className="text-[14.5px] text-ink">{candidate.label}</div>
                  <div className="mt-0.5 truncate text-[12px] text-ink-secondary">
                    {candidate.found ? sourceSummary(candidate) : "not found on this computer"}
                  </div>
                </div>
                {ok && <span className="shrink-0 text-[12.5px] text-ink-secondary">choose</span>}
              </button>
            );
          })}
          {!importable.length && (
            <div className="px-1 text-[12px] text-ink-secondary">no claude code, codex or cursor setup found in your home folder.</div>
          )}
        </div>
      )}

      {step === "bot" && source && (
        <div className="flex flex-col gap-3">
          <div className="text-[13px] text-ink-secondary">which bot gets your {source.label} setup?</div>
          <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
            {bots.map((bot) => (
              <button
                key={bot.id}
                type="button"
                onClick={() => {
                  setBotId(bot.id);
                  setStep("pick");
                }}
                className={cn(row, "bg-card hover:bg-raised-hover", bot.id === botId && "ring-1 ring-accent")}
              >
                <div className="min-w-0">
                  <div className="truncate text-[14px] text-ink">{bot.name}</div>
                  {bot.title && <div className="truncate text-[12px] text-ink-secondary">{bot.title}</div>}
                </div>
              </button>
            ))}
          </div>
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void createBot();
            }}
          >
            <input
              value={newBotName}
              onChange={(event) => setNewBotName(event.target.value)}
              placeholder="or name a new bot"
              maxLength={100}
              className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
            />
            <button type="submit" disabled={creating || !newBotName.trim()} className="shrink-0 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
              {creating ? "creating…" : "create"}
            </button>
          </form>
          <div className="flex">{!compact && backButton("source")}</div>
        </div>
      )}

      {step === "pick" && source && target && (
        <div className="flex flex-col gap-4">
          <div className="text-[13px] text-ink-secondary">
            bring from {source.label} into <span className="text-ink">{target.name}</span>.{" "}
            <button type="button" className="underline decoration-hairline underline-offset-2 hover:text-ink" onClick={() => setStep("bot")}>change bot</button>
          </div>

          {source.instructions && (
            <Section title="instructions" count={`${Math.ceil(source.instructions.bytes / 1000)} kb`}>
              <label className={row}>
                <Checkbox title="import instructions" checked={instructions} disabled={source.instructions.tooLong} onChange={setInstructions} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] text-ink">
                    {source.instructions.files.length === 1 ? source.instructions.files[0] : `${source.instructions.files[0]} and ${plural(source.instructions.files.length - 1, "imported file")}`}
                  </div>
                  {source.instructions.tooLong ? (
                    <div className="mt-0.5 text-[12px] text-warning">too long for a bot's instructions (24 kb limit). trim it in {source.label} first.</div>
                  ) : (
                    <pre className="mt-1.5 max-h-28 overflow-hidden whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-ink-secondary">{source.instructions.preview}</pre>
                  )}
                </div>
              </label>
              {instructions && (
                <div className="flex items-center gap-4 px-3 py-2 text-[12.5px] text-ink-secondary">
                  {(["append", "replace"] as const).map((value) => (
                    <label key={value} className="flex items-center gap-1.5">
                      <input type="radio" name="soul-mode" className="accent-accent" checked={mode === value} onChange={() => setMode(value)} />
                      {value === "append" ? "add below the bot's instructions" : "replace the bot's instructions"}
                    </label>
                  ))}
                </div>
              )}
            </Section>
          )}

          {source.skills.length > 0 && (
            <Section
              title="skills"
              count={`${skills.size} of ${source.skills.length}`}
              action={
                <button type="button" className="text-[12px] text-ink-secondary hover:text-ink" onClick={() => setSkills(skills.size ? new Set() : new Set(source.skills.filter((s) => !s.error).map((s) => s.name)))}>
                  {skills.size ? "none" : "all"}
                </button>
              }
            >
              {source.skills.map((skill) => (
                <label key={skill.path} className={row}>
                  <Checkbox title={skill.name} checked={skills.has(skill.name)} disabled={Boolean(skill.error)} onChange={(on) => setSkills(toggle(skills, skill.name, on))} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[12.5px] text-ink">{skill.name}</div>
                    {skill.description && <div className="mt-0.5 line-clamp-2 text-[11.5px] text-ink-secondary">{skill.description}</div>}
                    {skill.error && <div className="mt-0.5 text-[11.5px] text-danger">{skill.error}</div>}
                    {skill.warnings.length > 0 && <div className="mt-0.5 text-[11px] text-warning">lands off until you review it: {skill.warnings[0]}</div>}
                    {skill.supportFiles > 0 && <div className="mt-0.5 text-[11px] text-ink-secondary">{plural(skill.supportFiles, "supporting file")} not copied; bos imports SKILL.md only</div>}
                  </div>
                </label>
              ))}
            </Section>
          )}

          {source.mcpServers.length > 0 && (
            <Section title="mcp servers" count={`${servers.size} of ${source.mcpServers.length}`}>
              {source.mcpServers.map((server) => (
                <label key={server.id} className={row}>
                  <Checkbox title={server.name} checked={servers.has(server.id)} disabled={Boolean(server.error)} onChange={(on) => setServers(toggle(servers, server.id, on))} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[12.5px] text-ink">{server.name}</span>
                      <span className="text-[11px] text-ink-secondary">{server.transport}</span>
                      {server.needsSignIn && (
                        <span className="flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[10.5px] text-warning">
                          <KeyRound size={11} /> needs sign-in
                        </span>
                      )}
                      {server.disabledInSource && <span className="text-[10.5px] text-ink-secondary">off in {source.label}</span>}
                    </div>
                    <div className="mt-0.5 truncate text-[11.5px] text-ink-secondary" title={server.target}>{server.target}</div>
                    {server.scope !== "user" && <div className="mt-0.5 truncate text-[11px] text-ink-secondary" title={server.scope}>project: {server.scope}</div>}
                    {(server.envKeys.length > 0 || server.headerKeys.length > 0) && (
                      <div className="mt-0.5 truncate font-mono text-[10.5px] text-ink-secondary">{[...server.envKeys, ...server.headerKeys].join(" · ")}</div>
                    )}
                    {server.needsSignIn && <div className="mt-0.5 text-[11px] text-warning">lands off: {server.signInReasons.join(", ")}</div>}
                    {server.error && <div className="mt-0.5 text-[11.5px] text-danger">{server.error}</div>}
                  </div>
                </label>
              ))}
            </Section>
          )}

          {source.projects.length > 0 && (
            <Section title="working folder" count={plural(source.projects.length, "project")}>
              <label className={row}>
                <input type="radio" name="project" className="mt-0.5 accent-accent" checked={project === null} onChange={() => setProject(null)} />
                <div className="text-[13px] text-ink-secondary">keep {target.cwd ? target.cwd : "the bot's own folder"}</div>
              </label>
              <div className="max-h-48 overflow-y-auto">
                {source.projects.map((entry) => (
                  <label key={entry.path} className={row}>
                    <input type="radio" name="project" className="mt-0.5 accent-accent" checked={project === entry.path} onChange={() => setProject(entry.path)} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 text-[13px] text-ink"><FolderOpen size={13} className="text-ink-secondary" />{entry.name}</div>
                      <div className="truncate text-[11px] text-ink-secondary" title={entry.path}>{entry.path}</div>
                    </div>
                  </label>
                ))}
              </div>
            </Section>
          )}

          <div className="flex items-center justify-between gap-4 rounded-xl border border-hairline/40 bg-card px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-[13.5px] text-ink">keep in sync</div>
              <div className="text-[11.5px] text-ink-secondary">when the instructions or skills change in {source.label}, update the bot. if you edited them in bos too, you choose.</div>
            </div>
            <Switch checked={sync} onClick={() => setSync(!sync)} aria-label="keep in sync" />
          </div>

          <div className="px-1 text-[11.5px] text-ink-secondary">not imported: {leftOut(source)}.</div>

          <div className="flex items-center justify-between">
            {backButton(compact && importable.length === 1 ? "bot" : "source")}
            <button type="button" className={primary} disabled={nothingPicked} onClick={() => setStep("preview")}>preview</button>
          </div>
        </div>
      )}

      {step === "preview" && source && target && (
        <div className="flex flex-col gap-3">
          <div className="text-[13px] text-ink-secondary">this is what changes on <span className="text-ink">{target.name}</span>:</div>
          <ul className="flex flex-col gap-1.5 rounded-xl border border-hairline/40 bg-card px-4 py-3 text-[13px] text-ink">
            {instructions && <li>{mode === "replace" ? "replaces its instructions" : "adds to the end of its instructions"} with {source.label}'s</li>}
            {skills.size > 0 && <li>adds {plural(skills.size, "skill")}: <span className="text-ink-secondary">{[...skills].join(", ")}</span></li>}
            {pickedServers.length > 0 && (
              <li>
                adds {plural(pickedServers.length, "mcp server")}
                {pickedServers.some((server) => server.needsSignIn) && (
                  <span className="text-ink-secondary">; {pickedServers.filter((server) => server.needsSignIn).length} stay off until you sign in under connections</span>
                )}
              </li>
            )}
            {project && <li>works in <span className="font-mono text-[12px]">{project}</span></li>}
            <li className="text-ink-secondary">{sync ? `keeps following ${source.label} for changes` : "a one-time copy"}</li>
          </ul>
          <div className="text-[11.5px] text-ink-secondary">mcp servers are shared across bos; secrets stay in bos's own config, never in this window.</div>
          {error && <div role="alert" className="text-[12.5px] text-danger">{error}</div>}
          <div className="flex items-center justify-between">
            {backButton("pick")}
            <button type="button" className={primary} disabled={busy} onClick={() => void runImport()}>{busy ? "importing…" : "import"}</button>
          </div>
        </div>
      )}

      {step === "done" && result && (
        <div className="flex flex-col gap-3">
          <ul className="flex flex-col gap-1 rounded-xl border border-hairline/40 bg-card px-4 py-3 text-[12.5px]">
            {[result.instructions, ...result.skills, ...result.mcpServers, result.project]
              .filter((item): item is ItemResult => item !== null)
              .map((item, index) => (
                <li key={`${item.name}-${index}`} className="flex items-start gap-2">
                  <span className={cn("mt-0.5 shrink-0", item.ok ? "text-success" : "text-danger")}>{item.ok ? <Check size={13} /> : "×"}</span>
                  <span className="min-w-0">
                    <span className="font-mono text-ink">{item.name}</span>
                    <span className="text-ink-secondary"> · {item.message}</span>
                  </span>
                </li>
              ))}
          </ul>
          <div className="flex items-center justify-between">
            <button type="button" className={quiet} onClick={() => setStep("source")}>import something else</button>
            {onFinished && <button type="button" className={primary} onClick={onFinished}>done</button>}
          </div>
        </div>
      )}

      {step !== "preview" && error && <div role="alert" className="text-[12.5px] text-danger">{error}</div>}
    </div>
  );
}

/** Imports that keep following their source, with any conflicts to settle. */
function SyncedImports({ links, onChange }: { links: SyncLinkView[]; onChange: () => void }) {
  const { state } = useStore();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const name = (botId: string) => state.bots.find((bot) => bot.id === botId)?.name ?? "a removed bot";
  const labels: Record<SourceId, string> = { claude: "claude code", codex: "codex", cursor: "cursor" };

  async function call(key: string, path: string, init: RequestInit) {
    setBusy(key);
    setError("");
    try {
      await api(path, init);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  }

  if (!links.length) return null;
  return (
    <Card title="imported setups" subtitle="with sync on, bos checks the source files at launch and whenever they change.">
      {links.map((link) => {
        const parts = [link.instructions ? "instructions" : "", link.skills.length ? plural(link.skills.length, "skill") : ""].filter(Boolean);
        return (
          <div key={link.id} className="px-4">
            <SettingRow
              title={`${labels[link.source]} → ${name(link.botId)}`}
              subtitle={`${parts.join(" · ") || "nothing followed"}${link.instructions?.diverged ? " · instructions kept as edited in bos" : ""}`}
              message={
                link.conflicts.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    {link.conflicts.map((conflict) => {
                      const key = `${link.id}:${conflict.kind}:${conflict.name}`;
                      const resolve = (keep: "source" | "bos") => call(key, `/api/setup-import/links/${link.id}/resolve`, {
                        method: "POST",
                        body: JSON.stringify({ kind: conflict.kind, name: conflict.name, keep }),
                      });
                      return (
                        <div key={key} className="flex flex-wrap items-center gap-2 rounded-lg bg-warning/10 px-3 py-2">
                          <span className="min-w-0 flex-1 text-warning">
                            {conflict.kind === "skill" ? `skill ${conflict.name}` : "instructions"}: {conflict.reason}
                          </span>
                          <button type="button" disabled={busy === key} className="rounded-md bg-control px-2.5 py-1 text-[12px] text-ink hover:bg-raised-hover disabled:opacity-40" onClick={() => void resolve("source")}>
                            use {labels[link.source]}'s
                          </button>
                          <button type="button" disabled={busy === key} className="rounded-md bg-control px-2.5 py-1 text-[12px] text-ink hover:bg-raised-hover disabled:opacity-40" onClick={() => void resolve("bos")}>
                            keep bos's
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : undefined
              }
            >
              <div className="flex items-center gap-2">
                <Switch
                  checked={link.sync}
                  disabled={busy === link.id}
                  aria-label="keep in sync"
                  onClick={() => void call(link.id, `/api/setup-import/links/${link.id}`, { method: "PATCH", body: JSON.stringify({ sync: !link.sync }) })}
                />
                <button
                  type="button"
                  title="stop tracking this import (keeps what was imported)"
                  aria-label="stop tracking this import"
                  disabled={busy === link.id}
                  className="ui-icon-button flex size-8 items-center justify-center rounded-md text-ink-secondary hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                  onClick={() => void call(link.id, `/api/setup-import/links/${link.id}`, { method: "DELETE" })}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </SettingRow>
          </div>
        );
      })}
      {error && <div role="alert" className="px-4 pb-3 text-[12px] text-danger">{error}</div>}
    </Card>
  );
}

/** Settings > import. */
export function SetupImportSettings() {
  const [data, setData] = useState<DetectResponse | null>(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);

  const load = () => {
    detectSetups().then(setData).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };
  useEffect(load, []);

  async function checkNow() {
    setChecking(true);
    try {
      const next = await api<{ links: SyncLinkView[] }>("/api/setup-import/check", { method: "POST" });
      setData((current) => (current ? { ...current, links: next.links } : current));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  }

  return (
    <>
      <Card
        title="bring your setup"
        subtitle="import instructions, skills, mcp servers and a working folder from claude code, codex or cursor on this computer."
      >
        <div className="p-4">
          {error && !data ? (
            <div role="alert" className="text-[12.5px] text-danger">{error}</div>
          ) : !data ? (
            <div className="text-[12.5px] text-ink-secondary">looking for claude code, codex and cursor on this computer…</div>
          ) : (
            <SetupImportFlow initial={data} onLinksChanged={load} />
          )}
        </div>
      </Card>
      {data && data.links.length > 0 && (
        <>
          <SyncedImports links={data.links} onChange={load} />
          <div className="flex justify-end">
            <button type="button" disabled={checking} onClick={() => void checkNow()} className={cn(quiet, "flex items-center gap-1.5")}>
              <RefreshCw size={13} className={cn(checking && "animate-spin")} /> check for changes now
            </button>
          </div>
        </>
      )}
    </>
  );
}
