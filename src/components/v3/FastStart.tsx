// 3.0's 60-second start: paste your website or instagram, bos reads it and
// hires a starter team, and the first message is about your business
// (POST /api/onboarding/faststart, server/faststart.ts). When the page
// can't be read the card asks two questions instead. It sits above the
// composer in bos's first conversation, and on the empty home board.
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { api, openThread, useStore, type Bot } from "@/state/store";
import { setHomeOpen } from "@/lib/v3-home";
import { readingLabel } from "@/lib/v3-faststart";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";

type Ask = { id: "sell" | "buyers"; question: string };
type Started = { ok: true; botId: string; threadId: string; hired: Bot[]; ms: number; read: { name: string } };
type NeedsAnswers = { ok: false; reason: string; ask: Ask[]; known?: { url?: string } };

type Stage =
  | { kind: "link" }
  | { kind: "reading"; label: string; answers: boolean }
  | { kind: "ask"; reason: string; ask: Ask[]; url?: string }
  | { kind: "done"; name: string; seconds: number };

export function FastStart({ variant }: { variant: "chat" | "home" }) {
  const { state, dispatch } = useStore();
  const latest = useRef(state);
  latest.current = state;
  const [stage, setStage] = useState<Stage>({ kind: "link" });
  const [link, setLink] = useState("");
  const [answers, setAnswers] = useState({ sell: "", buyers: "" });
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const started = useRef(0);
  const firstField = useRef<HTMLInputElement>(null);
  const reading = stage.kind === "reading";

  useEffect(() => {
    if (!reading) return;
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started.current) / 1000)), 500);
    return () => clearInterval(timer);
  }, [reading]);
  useEffect(() => {
    if (stage.kind === "ask") firstField.current?.focus();
  }, [stage.kind]);

  const send = async (body: Record<string, unknown>, label: string, fromAnswers: boolean) => {
    if (!started.current) started.current = Date.now();
    setError(null);
    setElapsed(Math.round((Date.now() - started.current) / 1000));
    setStage({ kind: "reading", label, answers: fromAnswers });
    try {
      const result = await api<Started | NeedsAnswers>("/api/onboarding/faststart", { method: "POST", body: JSON.stringify(body), timeoutMs: 45_000 });
      if (!result.ok) {
        setStage({ kind: "ask", reason: result.reason, ask: result.ask, url: result.known?.url });
        return;
      }
      for (const bot of result.hired) dispatch({ type: "botAdded", bot });
      const seconds = Math.max(1, Math.round((Date.now() - started.current) / 1000));
      setStage({ kind: "done", name: result.read.name, seconds });
      setHomeOpen(false);
      openThread(dispatch, { botId: result.botId, threadId: result.threadId }, latest.current);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setStage(fromAnswers ? { kind: "ask", reason: "", ask: [], url: undefined } : { kind: "link" });
    }
  };

  const submitLink = () => {
    const value = link.trim();
    if (!value || reading) return;
    void send({ url: value }, readingLabel(value), false);
  };
  const submitAnswers = (url?: string) => {
    if (reading || answers.sell.trim().length < 2 || answers.buyers.trim().length < 2) return;
    void send({ answers: { sell: answers.sell.trim(), buyers: answers.buyers.trim() }, ...(url ? { url } : {}) }, "", true);
  };

  const askList = stage.kind === "ask" && stage.ask.length ? stage.ask : null;
  return (
    <section
      data-faststart={stage.kind}
      data-faststart-seconds={stage.kind === "done" ? stage.seconds : undefined}
      aria-label={t("v3.faststart.title")}
      className={cn("rounded-2xl border border-hairline/40 bg-panel px-4 py-3.5", variant === "chat" ? "mx-3 mb-2" : "")}
    >
      {stage.kind === "done" ? (
        <p role="status" className="text-[13.5px] text-ink">{t("v3.faststart.done", { name: stage.name, seconds: stage.seconds })}</p>
      ) : stage.kind === "reading" ? (
        <p role="status" className="flex items-center gap-2 text-[13.5px] text-ink">
          <Loader2 size={15} className="shrink-0 animate-spin text-ink-secondary" aria-hidden="true" />
          <span className="min-w-0 truncate">{stage.answers ? t("v3.faststart.hiring") : t("v3.faststart.reading", { what: stage.label })}</span>
          <span className="ml-auto shrink-0 tabular-nums text-[12px] text-ink-secondary">{t("v3.faststart.seconds", { count: elapsed })}</span>
        </p>
      ) : stage.kind === "ask" ? (
        <form onSubmit={(event) => { event.preventDefault(); submitAnswers(stage.url); }} className="grid gap-2.5">
          <div>
            <h2 className="text-[14px] font-semibold text-ink">{t("v3.faststart.askTitle")}</h2>
            {stage.reason && <p className="mt-0.5 text-[12.5px] text-ink-secondary">{stage.reason}</p>}
          </div>
          {(askList ?? [
            { id: "sell" as const, question: t("v3.faststart.sell") },
            { id: "buyers" as const, question: t("v3.faststart.buyers") },
          ]).map((item, index) => (
            <label key={item.id} className="grid gap-1 text-[12.5px] text-ink-secondary">
              {item.question}
              <input
                ref={index === 0 ? firstField : undefined}
                value={answers[item.id]}
                maxLength={600}
                onChange={(event) => setAnswers((current) => ({ ...current, [item.id]: event.target.value }))}
                className="rounded-xl border border-hairline/40 bg-inset px-3 py-2 text-[13.5px] text-ink outline-none focus:border-hairline"
              />
            </label>
          ))}
          {error && <p role="alert" className="text-[12.5px] text-danger">{error}</p>}
          <div className="flex justify-end">
            <button type="submit" disabled={answers.sell.trim().length < 2 || answers.buyers.trim().length < 2}
              className="flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 text-[13px] font-medium text-white disabled:opacity-40">
              {t("v3.faststart.startTeam")}<ArrowRight size={14} aria-hidden="true" />
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={(event) => { event.preventDefault(); submitLink(); }} className="grid gap-2">
          <div>
            <h2 className="text-[14px] font-semibold text-ink">{t("v3.faststart.title")}</h2>
            <p className="mt-0.5 text-[12.5px] text-ink-secondary">{t("v3.faststart.intro")}</p>
          </div>
          <div className="flex items-center gap-2">
            <input
              value={link}
              onChange={(event) => setLink(event.target.value)}
              placeholder={t("v3.faststart.placeholder")}
              aria-label={t("v3.faststart.placeholder")}
              maxLength={500}
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-xl border border-hairline/40 bg-inset px-3 py-2 text-[13.5px] text-ink outline-none focus:border-hairline"
            />
            <button type="submit" disabled={!link.trim()}
              className="flex shrink-0 items-center gap-1.5 rounded-full bg-accent px-3.5 py-2 text-[13px] font-medium text-white disabled:opacity-40">
              {t("v3.faststart.read")}<ArrowRight size={14} aria-hidden="true" />
            </button>
          </div>
          {error && <p role="alert" className="text-[12.5px] text-danger">{error}</p>}
          <button type="button" onClick={() => setStage({ kind: "ask", reason: "", ask: [] })}
            className="justify-self-start text-[12px] text-ink-secondary underline-offset-2 hover:text-ink hover:underline">
            {t("v3.faststart.noLink")}
          </button>
        </form>
      )}
    </section>
  );
}
