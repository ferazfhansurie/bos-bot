// Beat: what's installed. One list, ready engines first, each row a mark,
// a name, a version and a status pill; an engine that needs work opens its
// setup inline under the row, with the instructions from the driver so
// they are right for this platform. A summary line says the whole story in
// a glance and offers Check again, because the user often installs from a
// terminal and comes back. The guide reacts to the result.
// BOS AI leads: every install starts free on it, with no sign-in. Claude and
// ChatGPT sit under it for people who already pay for one.
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, RefreshCw } from "lucide-react";
import { BosAiCard } from "../BosAiCard";
import { EngineSetup } from "@/components/EngineSetup";
import { engineReady } from "@/components/EngineLibrary";
import { InstanceProviderMark } from "@/components/ProviderIcons";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useAppConfig } from "@/lib/app-config";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { PrimaryButton, staggerIndex, type BeatProps } from "./shared";

function version(instance: InstanceInfo): string | null {
  return instance.snapshot.version
    ? instance.snapshot.version.split(" ")[0]!
    : null;
}

function StatusPill({ ready }: { ready: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
        ready ? "bg-success/15 text-success" : "bg-warning/15 text-warning",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          ready ? "bg-success" : "bg-warning",
        )}
        aria-hidden="true"
      />
      {ready
        ? t("onboarding.engines.ready")
        : t("onboarding.engines.needsSetup")}
    </span>
  );
}

function SkeletonRow({ index }: { index: number }) {
  return (
    <div
      className="animate-rise flex items-center gap-3 px-3.5 py-3"
      style={staggerIndex(index)}
      aria-hidden="true"
    >
      <span className="size-[18px] rounded-md bg-raised" />
      <span className="h-3 w-32 rounded bg-raised" />
      <span className="ml-auto h-4 w-14 rounded-full bg-raised" />
    </div>
  );
}

/** `inline` drops the Continue button: the chat sign-in card moves on by itself
 * once an engine is ready. */
export function EnginesBeat({ onNext, setMascot, bump, inline }: Omit<BeatProps, "onSkip"> & Partial<Pick<BeatProps, "onSkip">> & { inline?: boolean }) {
  const config = useAppConfig();
  const { state, dispatch } = useStore();
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const latestRequest = useRef(0);
  // EngineSetup updates the shared inventory after sign-in. Keep that source
  // of truth instead of a private snapshot that remains stale until focus.
  const instances = loaded || state.instances.length ? state.instances : null;
  const [checking, setChecking] = useState(false);
  // A hosted bos whose computer is still waking answers from a saved copy and
  // says so: sign-in needs the computer, so the card waits until it is up.
  const [waking, setWaking] = useState(false);
  // Every setup block starts closed; a row opens its own on click. The
  // list stays a scannable summary until the user chooses an engine.
  const [open, setOpen] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const request = ++latestRequest.current;
    setChecking(true);
    try {
      const d = await api("/api/instances", {
        signal: AbortSignal.timeout(10_000),
      });
      if (request !== latestRequest.current) return;
      dispatch({ type: "instances", instances: d.instances ?? [] });
      setWaking(d.waking === true);
      dispatch({ type: "hostedSignIn", on: d.hosted === true || d.waking === true });
      setLoaded(true);
      setFailed(false);
    } catch {
      if (request === latestRequest.current) setFailed(true);
    } finally {
      if (request === latestRequest.current) setChecking(false);
    }
  }, [dispatch]);

  useEffect(() => {
    void refresh();
    return () => {
      latestRequest.current++;
    };
  }, [refresh]);

  useEffect(() => {
    if (!waking || checking) return;
    const timer = window.setTimeout(() => void refresh(), 2500);
    return () => window.clearTimeout(timer);
  }, [waking, checking, refresh]);

  const engines = (instances ?? []).filter((instance) => instance.install);
  const ready = engines.filter(engineReady);
  const setup = engines.filter((e) => !engineReady(e));
  const allReady = instances !== null && ready.length > 0 && setup.length === 0;
  const expanded = open;

  // The guide searches while the harness answers, then looks proud or
  // curious depending on whether there is work left for the user.
  useEffect(() => {
    if (instances === null) {
      setMascot("searching");
      return;
    }
    if (allReady) {
      setMascot("proud");
      bump("success");
    } else {
      setMascot("curious");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instances === null, allReady, setup.length]);

  const isPrimary = (e: InstanceInfo) =>
    e.driverKind === "claudeAgent" || e.driverKind === "codex";
  const primary = [...ready, ...setup].filter(isPrimary);
  const others = [...ready, ...setup].filter((e) => !isPrimary(e));
  // something already works under More (BOS Free, a key): show it rather than hide it
  const [more, setMore] = useState(false);
  useEffect(() => {
    if (others.some(engineReady)) setMore(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [others.some(engineReady)]);
  const label = (instance: InstanceInfo) =>
    instance.driverKind === "codex"
      ? "ChatGPT"
      : instance.driverKind === "claudeAgent"
        ? "Claude"
        : instance.displayName;
  const row = (instance: InstanceInfo, i: number) => {
    const ok = engineReady(instance);
    const v = version(instance);
    return (
      <div
        key={instance.instanceId}
        className="animate-rise"
        style={staggerIndex(i)}
      >
        {ok ? (
          <div className="flex items-center gap-3 px-3.5 py-3">
            <span className="flex size-[18px] shrink-0 items-center justify-center">
              <InstanceProviderMark instance={instance} size={18} />
            </span>
            <div className="flex min-w-0 flex-1 items-baseline gap-2">
              <span className="truncate text-[13.5px] font-medium text-ink">
                {label(instance)}
              </span>
              {v && (
                <span className="shrink-0 text-[11.5px] tabular-nums text-ink-secondary">
                  {v}
                </span>
              )}
            </div>
            <StatusPill ready />
          </div>
        ) : (
          <button
            type="button"
            onClick={() =>
              setOpen(
                expanded === instance.instanceId ? null : instance.instanceId,
              )
            }
            aria-expanded={expanded === instance.instanceId}
            className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-raised/40"
          >
            <span className="flex size-[18px] shrink-0 items-center justify-center">
              <InstanceProviderMark instance={instance} size={18} />
            </span>
            <div className="flex min-w-0 flex-1 items-baseline gap-2">
              <span className="truncate text-[13.5px] font-medium text-ink">
                {label(instance)}
              </span>
              {v && (
                <span className="shrink-0 text-[11.5px] tabular-nums text-ink-secondary">
                  {v}
                </span>
              )}
            </div>
            <StatusPill ready={false} />
            <ChevronDown
              size={14}
              className={cn(
                "shrink-0 text-ink-secondary transition-transform duration-200",
                expanded === instance.instanceId && "rotate-180",
              )}
            />
          </button>
        )}
        {!ok && expanded === instance.instanceId && (
          <EngineSetup
            instance={instance}
            intent={instance.access === "custom" ? "inject" : "cloud"}
            className="mx-3.5 mb-3.5 border-0 bg-inset"
          />
        )}
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-col">
      <p className="animate-rise mt-1 text-[13.5px] text-ink-secondary">
        {config.flags.freeEngine ? "BOS AI gets you started free. Already pay for Claude or ChatGPT? Connect it below." : t("onboarding.engines.loginIntro")}
      </p>

      {config.flags.freeEngine && !waking && <BosAiCard className="mt-3" />}

      <div
        className="animate-rise mt-4 divide-y divide-hairline/40 rounded-xl border border-hairline/40 bg-card"
        style={staggerIndex(1)}
      >
        {instances === null ? (
          !failed && [0, 1].map((i) => <SkeletonRow key={i} index={i} />)
        ) : waking ? (
          <p className="flex items-center gap-2 px-3.5 py-3 text-[13px] text-ink-secondary" aria-live="polite" data-engines-waking>
            <RefreshCw size={13} className="animate-spin" />
            {t("onboarding.engines.waking")}
          </p>
        ) : primary.length ? (
          primary.map(row)
        ) : (
          <p className="px-3.5 py-3 text-[13px] text-ink-secondary">
            {failed
              ? t("onboarding.engines.error")
              : t("onboarding.engines.noLogin")}
          </p>
        )}
      </div>

      <button
        type="button"
        onClick={() => setMore(!more)}
        aria-expanded={more}
        className="animate-rise mt-4 flex items-center gap-1.5 self-start text-[12.5px] text-ink-secondary transition-colors hover:text-ink"
        style={staggerIndex(2)}
      >
        {t("onboarding.engines.more")}
        <ChevronDown
          size={13}
          className={cn(
            "transition-transform duration-200",
            more && "rotate-180",
          )}
        />
      </button>

      {more && (
        <>
          {/* the whole story in one line, and the way back after a terminal trip */}
          <div className="animate-rise mt-4 flex items-center justify-between gap-3">
            <div
              className={cn(
                "flex items-center gap-2 text-[12.5px]",
                allReady ? "text-success" : "text-ink-secondary",
              )}
              aria-live="polite"
            >
              {instances === null ? (
                <span>
                  {failed
                    ? t("onboarding.engines.error")
                    : t("common.checking")}
                </span>
              ) : allReady ? (
                <>
                  <Check size={14} strokeWidth={2.5} />
                  <span>{t("onboarding.engines.allReady")}</span>
                </>
              ) : (
                <span className="tabular-nums">
                  {t("onboarding.engines.readyCount", { count: ready.length })}
                  <span className="mx-1.5 text-hairline">·</span>
                  {t("onboarding.engines.setupCount", { count: setup.length })}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={checking}
              className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-ink-secondary transition-colors hover:bg-raised hover:text-ink disabled:opacity-50"
            >
              <RefreshCw size={12} className={checking ? "animate-spin" : ""} />
              {checking ? t("common.checking") : t("common.checkAgain")}
            </button>
          </div>
          {failed && instances !== null && (
            <p role="alert" className="mt-2 text-[13px] text-danger">
              {t("onboarding.engines.error")}
            </p>
          )}

          <div className="mt-2.5 min-h-0 divide-y divide-hairline/40 overflow-y-auto rounded-xl border border-hairline/40 bg-card [scrollbar-width:thin]">
            {instances === null
              ? !failed &&
                [0, 1, 2].map((i) => <SkeletonRow key={i} index={i} />)
              : others.map(row)}
          </div>
        </>
      )}

      {!inline && (
        <PrimaryButton onClick={onNext} className="mt-5">
          {t("onboarding.continue")}
        </PrimaryButton>
      )}
    </div>
  );
}
