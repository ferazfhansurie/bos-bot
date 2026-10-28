// The realtime voice call UI, laid out after Grok Bot desktop's call popover:
// a capsule under the chat header holding the bot's face, a two-layer
// waveform and four round controls (settings, transcript, mute, hang up),
// with a tray that springs open for settings or the live transcript.

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { AudioLines, ChevronsUpDown, MessageSquareMore, Mic, MicOff, Settings, TriangleAlert, X } from "lucide-react";

import { BotAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import { MAUS_COLORS, type MausState } from "@/lib/mascot";
import { resolveMausColor } from "../../../shared/glyph-faces";
import type { CallActivity, VoiceCallEngine, VoiceCallSnapshot } from "@/lib/voice-call/engine";
import { formatCallDuration } from "@/lib/voice-call/protocol";
import {
  dismissRealtimeCall,
  setCallPopoverHidden,
  prewarmRealtimeCall,
  startRealtimeCall,
  useCallPopoverHidden,
  useRealtimeCall,
} from "@/lib/voice-call/session";
import type { Bot } from "@/state/store";

import { Waveform } from "./Waveform";

type Tray = "settings" | "transcript" | null;

const EMPTY: VoiceCallSnapshot = {
  botId: "",
  phase: "idle",
  activity: "idle",
  muted: false,
  settings: null,
  options: null,
  transcript: [],
  failure: null,
  fault: null,
  startedAtMs: null,
  streams: { microphone: null, speaker: null },
  pendingTasks: 0,
};

const noop = () => () => undefined;

export function useCallSnapshot(engine: VoiceCallEngine | null): VoiceCallSnapshot {
  return useSyncExternalStore(
    engine ? engine.subscribe : noop,
    engine ? engine.getSnapshot : () => EMPTY,
    engine ? engine.getSnapshot : () => EMPTY,
  );
}

/** True while a realtime call is on the line (not ended, not failed). */
export function callIsOn(snapshot: VoiceCallSnapshot): boolean {
  return snapshot.phase === "connecting" || snapshot.phase === "live" || snapshot.phase === "reconnecting" || snapshot.phase === "ending";
}

const AVATAR_STATE: Record<CallActivity, MausState> = {
  listening: "listening",
  thinking: "thinking",
  streaming: "sending",
  idle: "idle",
};

function agentColor(bot: Pick<Bot, "color">): string {
  return /^#[0-9A-Fa-f]{6}$/.test(bot.color) || Object.hasOwn(MAUS_COLORS, bot.color) ? resolveMausColor(bot.color) : MAUS_COLORS.blue;
}

function useDuration(startedAtMs: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAtMs === null) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [startedAtMs]);
  return formatCallDuration(startedAtMs === null ? 0 : now - startedAtMs);
}

// ── entry button ─────────────────────────────────────────────────────────

export function RealtimeCallButton({ bot }: { bot: Bot }) {
  const label = `Call ${bot.name}`;
  return (
    <button
      type="button"
      onClick={() => startRealtimeCall(bot.id)}
      onPointerEnter={() => prewarmRealtimeCall(bot.id)}
      onFocus={() => prewarmRealtimeCall(bot.id)}
      aria-label={label}
      title={label}
      data-voice-call-start
      className="relative flex size-9 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-raised hover:text-ink"
    >
      <AudioLines size={17} />
    </button>
  );
}

// ── header chip ──────────────────────────────────────────────────────────

/** Avatar + running timer, tinted with the bot's color. On the callee's chat
 * it shows or tucks away the popover; elsewhere it returns to that chat. */
export function CallChip({ bot, onReturn }: { bot: Bot; onReturn: () => void }) {
  const engine = useRealtimeCall();
  const snapshot = useCallSnapshot(engine);
  const duration = useDuration(snapshot.startedAtMs);
  const color = agentColor(bot);
  return (
    <button
      type="button"
      data-voice-call-active
      onClick={onReturn}
      aria-label={`call with ${bot.name}`}
      title={`Call with ${bot.name}`}
      className="flex h-10 w-auto items-center rounded-full pe-3.5 ps-2.5 text-ink transition-[filter] hover:brightness-90"
      style={{ backgroundColor: `color-mix(in srgb, ${color} 22%, transparent)` }}
    >
      <span className="inline-flex items-center gap-2">
        <BotAvatar bot={bot} size={24} state={AVATAR_STATE[snapshot.activity]} animated />
        <span className="text-[14px] font-medium tabular-nums">
          {snapshot.phase === "live" || snapshot.phase === "ending" ? duration : snapshot.phase === "reconnecting" ? "Reconnecting" : "Calling"}
        </span>
      </span>
    </button>
  );
}

// ── popover ──────────────────────────────────────────────────────────────

export function VoiceCallPopover({ bot }: { bot: Bot }) {
  const engine = useRealtimeCall();
  const snapshot = useCallSnapshot(engine);
  const hidden = useCallPopoverHidden();
  const [tray, setTray] = useState<Tray>(null);
  const [shownTray, setShownTray] = useState<Exclude<Tray, null>>("transcript");

  useEffect(() => {
    if (tray) setShownTray(tray);
  }, [tray]);

  useEffect(() => {
    if (!tray) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTray(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [tray]);

  if (!engine || engine.botId !== bot.id || hidden) return null;
  if (snapshot.phase === "idle") return null;

  const color = agentColor(bot);
  const failed = snapshot.phase === "failed";

  return (
    <section
      data-voice-call-popover
      data-voice-call-phase={snapshot.phase}
      data-voice-call-tray={tray ?? "none"}
      data-voice-call-tray-kind={shownTray}
      aria-label={`Voice call with ${bot.name}`}
      className={cn(
        "absolute left-1/2 top-[58px] z-40 mt-2.5 flex max-w-[calc(100%-24px)] -translate-x-1/2 flex-col overflow-hidden rounded-[34px] bg-menu text-ink",
        "shadow-[inset_0_0_0_0.5px_var(--color-hairline),0_16px_48px_-12px_rgba(0,0,0,0.45),0_4px_14px_rgba(0,0,0,0.18)]",
        failed ? "w-[320px]" : "w-max",
      )}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      {failed ? (
        <FailureCard snapshot={snapshot} />
      ) : (
        <>
          <div data-voice-call-frame className="flex w-full shrink-0 flex-col items-center gap-4 p-3">
            <div data-voice-call-chrome className="flex items-center gap-6">
              <div data-voice-call-activity className="flex items-center gap-2.5 ps-2">
                <span className="flex size-9 shrink-0 items-center justify-center">
                  <BotAvatar bot={bot} size={36} state={AVATAR_STATE[snapshot.activity]} animated />
                </span>
                <CallWave snapshot={snapshot} color={color} />
              </div>
              <div data-voice-call-controls className="flex items-center gap-2">
                <ControlButton
                  label={tray === "settings" ? "Hide call settings" : "Call settings"}
                  pressed={tray === "settings"}
                  expanded={tray === "settings"}
                  dataAttr="data-voice-call-settings-toggle"
                  onClick={() => setTray((t) => (t === "settings" ? null : "settings"))}
                  disabled={!snapshot.settings}
                >
                  <Settings size={18} />
                </ControlButton>
                <ControlButton
                  label={tray === "transcript" ? "Hide transcript" : "Show transcript"}
                  pressed={tray === "transcript"}
                  expanded={tray === "transcript"}
                  dataAttr="data-voice-call-transcript-toggle"
                  onClick={() => setTray((t) => (t === "transcript" ? null : "transcript"))}
                >
                  <MessageSquareMore size={18} />
                </ControlButton>
                <ControlButton
                  label={snapshot.muted ? "Unmute" : "Mute"}
                  pressed={snapshot.muted}
                  ariaPressed={snapshot.muted}
                  onClick={() => engine.setMuted(!snapshot.muted)}
                >
                  {snapshot.muted ? <MicOff size={18} /> : <Mic size={18} />}
                </ControlButton>
                <button
                  type="button"
                  onClick={() => engine.hangUp()}
                  disabled={snapshot.phase === "ending"}
                  aria-label="Hang up"
                  title="Hang up"
                  className="flex size-10 items-center justify-center rounded-full bg-[#ff263c] text-white transition-colors hover:bg-[#c21d2e] disabled:opacity-60"
                >
                  <X size={18} strokeWidth={2.25} />
                </button>
              </div>
            </div>
            {snapshot.fault && (
              <p role="status" className="flex items-center justify-center gap-1.5 text-center text-[13px] text-warning">
                <TriangleAlert size={14} className="shrink-0" />
                <span>{snapshot.fault}</span>
              </p>
            )}
            {snapshot.phase === "reconnecting" && !snapshot.fault && (
              <p role="status" className="text-center text-[13px] text-ink-secondary">
                Reconnecting…
              </p>
            )}
          </div>
          <TrayPanel open={tray !== null}>
            {shownTray === "settings" ? <CallSettings engine={engine} snapshot={snapshot} /> : <CallTranscript snapshot={snapshot} />}
          </TrayPanel>
        </>
      )}
    </section>
  );
}

function CallWave({ snapshot, color }: { snapshot: VoiceCallSnapshot; color: string }) {
  const live = snapshot.phase === "live" || snapshot.phase === "ending";
  return (
    <span data-voice-call-wave={live ? "live" : "pending"} className="relative h-7 w-24">
      {live ? (
        <>
          <span
            className="absolute inset-0 flex items-center justify-center transition-opacity duration-300"
            style={{ opacity: snapshot.activity === "streaming" ? 1 : 0.2 }}
          >
            <Waveform
              stream={snapshot.streams.speaker}
              barColor={color}
              barHeight={3}
              fallback={snapshot.streams.speaker === null ? "simulated" : "static"}
            />
          </span>
          <span className="absolute inset-0 flex items-center justify-center" style={{ transform: "scaleX(-1)" }}>
            <Waveform
              stream={snapshot.muted ? null : snapshot.streams.microphone}
              barColor={color}
              barHeight={0}
              noiseFloor="adaptive"
            />
          </span>
        </>
      ) : (
        <span className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 overflow-hidden rounded-full" style={{ backgroundColor: `color-mix(in srgb, ${color} 18%, transparent)` }}>
          <span
            className="voice-call-indeterminate absolute inset-y-0 left-0 w-[34%] rounded-full"
            style={{ backgroundColor: color }}
          />
        </span>
      )}
    </span>
  );
}

function ControlButton({
  label,
  pressed,
  expanded,
  ariaPressed,
  dataAttr,
  disabled,
  onClick,
  children,
}: {
  label: string;
  pressed: boolean;
  expanded?: boolean;
  ariaPressed?: boolean;
  dataAttr?: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const data = dataAttr ? { [dataAttr]: "" } : {};
  return (
    <button
      type="button"
      {...data}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      aria-pressed={ariaPressed}
      className={cn(
        "flex size-10 items-center justify-center rounded-full transition-colors disabled:opacity-50",
        pressed ? "bg-[#7777772b] text-ink" : "bg-raised text-ink hover:bg-raised-hover",
      )}
    >
      {children}
    </button>
  );
}

function TrayPanel({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div
      data-voice-call-tray-panel={open ? "open" : "closed"}
      className="grid min-w-0"
      style={{
        gridTemplateRows: open ? "1fr" : "0fr",
        pointerEvents: open ? "auto" : "none",
        contain: "inline-size",
        transition: "grid-template-rows 300ms cubic-bezier(0.32, 0.72, 0, 1)",
      }}
      aria-hidden={!open}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          style={{
            transform: open ? "translateY(0)" : "translateY(-10px)",
            transition: "transform 300ms cubic-bezier(0.32, 0.72, 0, 1)",
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function CallTranscript({ snapshot }: { snapshot: VoiceCallSnapshot }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const turns = snapshot.transcript;
  const lastText = turns.length ? turns[turns.length - 1].text : "";

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [turns.length, lastText]);

  return (
    <div
      ref={scrollRef}
      role="log"
      aria-label="Call transcript"
      onScroll={(event) => {
        const el = event.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className="max-h-[240px] w-full overflow-y-auto border-t-[0.5px] border-hairline"
    >
      <div className="flex flex-col gap-2.5 p-4">
        {turns.length === 0 ? (
          <p className="self-center text-[13px] text-ink-secondary">Nothing said yet.</p>
        ) : (
          turns.map((turn) => (
            <p
              key={turn.id}
              className={cn(
                "max-w-[88%] select-text whitespace-pre-wrap rounded-[14px] px-3 py-2 text-[14px] leading-snug [overflow-wrap:anywhere]",
                turn.speaker === "user"
                  ? "self-end bg-bubble-user text-bubble-user-ink"
                  : "self-start bg-raised text-ink",
              )}
            >
              {turn.text}
            </p>
          ))
        )}
      </div>
    </div>
  );
}

const LANGUAGE_NAMES: Record<string, string> = { auto: "Auto" };

function languageLabel(code: string): string {
  if (LANGUAGE_NAMES[code]) return LANGUAGE_NAMES[code];
  try {
    const name = new Intl.DisplayNames(undefined, { type: "language" }).of(code);
    return name && name !== code ? name : code;
  } catch {
    return code;
  }
}

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const speedLabel = (speed: number) => `${speed}x`;

function CallSettings({ engine, snapshot }: { engine: VoiceCallEngine; snapshot: VoiceCallSnapshot }) {
  const settings = snapshot.settings;
  const options = snapshot.options;
  if (!settings || !options) return null;
  return (
    <div data-voice-call-settings className="flex w-full flex-col gap-2 border-t-[0.5px] border-hairline px-4 pb-4 pt-2">
      <SettingRow
        label="Voice"
        value={settings.voice}
        options={options.voices.map((v) => ({ value: v, label: capitalize(v) }))}
        onChange={(voice) => engine.updateSettings({ voice })}
      />
      <SettingRow
        label="Speed"
        value={String(settings.speed)}
        options={options.speeds.map((s) => ({ value: String(s), label: speedLabel(s) }))}
        onChange={(speed) => engine.updateSettings({ speed: Number(speed) })}
      />
      <SettingRow
        label="Language"
        value={settings.language}
        options={options.languages.map((l) => ({ value: l, label: languageLabel(l) }))}
        onChange={(language) => engine.updateSettings({ language })}
      />
    </div>
  );
}

function SettingRow({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  const current = options.find((o) => o.value === value)?.label ?? value;
  return (
    <label className="relative flex min-h-9 items-center justify-between gap-6 text-[14px]">
      <span className="text-ink">{label}</span>
      <span className="flex items-center gap-1 text-ink-secondary">
        <span>{current}</span>
        <ChevronsUpDown size={14} aria-hidden="true" />
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function FailureCard({ snapshot }: { snapshot: VoiceCallSnapshot }) {
  const failure = snapshot.failure ?? { code: "unknown", title: "The call ended", detail: "" };
  return (
    <div role="alert" data-voice-call-failure className="flex flex-col items-stretch gap-3 p-4">
      <div className="flex items-start gap-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-danger/15 text-danger">
          <TriangleAlert size={15} />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-[14px] font-medium text-ink">{failure.title}</p>
          {failure.detail && <p className="text-[13px] text-ink-secondary">{failure.detail}</p>}
        </div>
      </div>
      <button
        type="button"
        onClick={() => dismissRealtimeCall()}
        className="self-end rounded-full bg-raised px-3 py-1 text-[13px] text-ink hover:bg-raised-hover"
      >
        Dismiss
      </button>
    </div>
  );
}

/** Header control: the chip while a realtime call is on, else the call button. */
export function RealtimeCallControl({ bot, callee, onSelectCallee }: {
  bot: Bot;
  callee: Bot | undefined;
  onSelectCallee: (botId: string) => void;
}) {
  const engine = useRealtimeCall();
  const snapshot = useCallSnapshot(engine);
  const hidden = useCallPopoverHidden();
  if (engine && callee && callIsOn(snapshot)) {
    return (
      <CallChip
        bot={callee}
        onReturn={() => {
          if (callee.id === bot.id) setCallPopoverHidden(!hidden);
          else {
            setCallPopoverHidden(false);
            onSelectCallee(callee.id);
          }
        }}
      />
    );
  }
  return <RealtimeCallButton bot={bot} />;
}
