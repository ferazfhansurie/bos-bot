// The question box: what the bot actually asked, and its own answers.
//
// This is the card for a structured ask — Claude's AskUserQuestion. The
// provider routes it through the permission channel, so without this it
// arrived as "Deny / Always allow / Allow once" over a question like "which
// model should this bot run on?", which is not an answer to anything.
//
// One tab per question (the model names them), the model's options as rows
// with their descriptions, an "Other" field for a reply it did not think of,
// and a single submit that sends every answer back at once — the shape a
// person can read at a glance and answer without scrolling back up.
import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import { useStore, type Bot, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import {
  answerWithoutPreamble,
  formatQuestionAnswers,
  MAX_CUSTOM_ANSWER,
  type AskQuestion,
} from "../../shared/ask-question";

/** What each question has been answered with so far. Option labels and the
 * free-text reply are kept apart so toggling "Other" off cannot silently
 * drop a choice the person already made. */
interface Draft {
  picked: string[];
  custom: string;
  /** "Other" is open. An empty open field is not an answer. */
  other: boolean;
}

const EMPTY: Draft = { picked: [], custom: "", other: false };

function answersOf(draft: Draft): string[] {
  const custom = draft.other ? draft.custom.trim() : "";
  return custom ? [...draft.picked, custom] : draft.picked;
}

/** The tab label: the model's own header, or a number when it gave none. */
function tabLabel(question: AskQuestion, index: number): string {
  return question.header ?? t("question.tab.numbered", { index: index + 1 });
}

export function QuestionCard({
  threadId,
  bot,
  message,
}: {
  /** answered by THREAD, so a question raised inside a room settles the
   * same way as one in a 1:1 chat */
  threadId: string;
  /** who is asking, for the "Name has a question" line */
  bot?: Bot;
  message: Message;
}) {
  const { dispatch } = useStore();
  const card = message.card;
  const questions = card?.questionRequest?.questions ?? [];
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [active, setActive] = useState(0);
  // The server settles the card, but only after a round trip. Holding the
  // sent answer here closes the window where the buttons are still live.
  const [sent, setSent] = useState<string | null>(null);

  const answered = useMemo(
    () => questions.map((_, index) => answersOf(drafts[index] ?? EMPTY).length > 0),
    [questions, drafts],
  );

  if (!card || !questions.length) return null;
  const settled = Boolean(card.answered) || sent !== null;
  const current = questions[Math.min(active, questions.length - 1)]!;
  const currentIndex = Math.min(active, questions.length - 1);
  const draft = drafts[currentIndex] ?? EMPTY;
  const answeredCount = answered.filter(Boolean).length;
  const complete = answeredCount === questions.length;

  const update = (index: number, next: Partial<Draft>) =>
    setDrafts((previous) => ({ ...previous, [index]: { ...(previous[index] ?? EMPTY), ...next } }));

  const choose = (label: string) => {
    if (settled) return;
    if (current.multiSelect) {
      const picked = draft.picked.includes(label)
        ? draft.picked.filter((entry) => entry !== label)
        : [...draft.picked, label];
      update(currentIndex, { picked });
      return;
    }
    // Single-select is a radio group: picking replaces, and picking an
    // option means the free-text answer was not the one they wanted.
    update(currentIndex, { picked: [label], other: false, custom: "" });
    // One question with one answer: the tap is the answer, like Grok's
    // option buttons. Nothing else is owed, so there is nothing to confirm.
    if (questions.length === 1) {
      send([[label]]);
      return;
    }
    // Move to the next question they still owe an answer to, the way the
    // tabs would have been clicked anyway. The last one stays put so the
    // submit button is under the cursor that just chose.
    const next = questions.findIndex((_, index) => index !== currentIndex && !answered[index]);
    if (next >= 0) setActive(next);
  };

  // The field under the options is the "Other" answer. Typing in it picks
  // it; on a single-select question that replaces the chosen option.
  const type = (custom: string) => {
    if (settled) return;
    const other = custom.trim().length > 0;
    update(currentIndex, { custom, other, ...(other && !current.multiSelect ? { picked: [] } : {}) });
  };

  const send = (answers: string[][]) => {
    if (settled || !card.requestId) return;
    const answer = formatQuestionAnswers(questions, answers);
    if (!answer) return;
    setSent(answer);
    dispatch({
      type: "decideRequest",
      threadId,
      requestId: card.requestId,
      behavior: "answer",
      message: answer,
      // The answer never reached the bot, so the card must go back to
      // being answerable rather than sitting there looking settled.
      onError: () => setSent(null),
    });
  };

  const submit = () => {
    if (!complete) return;
    send(questions.map((_, index) => answersOf(drafts[index] ?? EMPTY)));
  };

  // Grok's inline form: the question reads like the bot's own bubble, the
  // options are tappable rows, and a rounded field with a round check takes
  // anything else. Answered, it shrinks to the question and the reply.
  return (
    <div
      role="group"
      aria-label={t("question.aria.card")}
      className={cn(
        "animate-pop-in w-full max-w-[600px] rounded-[22px] bg-raised/70 px-4 py-3.5 transition-opacity duration-300",
        settled && "opacity-75",
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[12.5px] font-medium text-ink-secondary">
          {bot ? t("question.card.named", { name: bot.name }) : t("question.card.title")}
        </div>
        {questions.length > 1 && !settled && (
          <span className="shrink-0 text-[11.5px] tabular-nums text-ink-secondary">
            {t("question.progress", { answered: answeredCount, count: questions.length })}
          </span>
        )}
      </div>

      {questions.length > 1 && !settled && (
        <div role="tablist" aria-label={t("question.aria.tabs")} className="mt-2.5 flex flex-wrap gap-1">
          {questions.map((question, index) => (
            <button
              key={`${index}-${question.question}`}
              type="button"
              role="tab"
              aria-selected={index === currentIndex}
              onClick={() => setActive(index)}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-full px-3 text-[12.5px] transition-colors",
                index === currentIndex ? "bg-ink text-app" : "text-ink-secondary hover:bg-raised-hover hover:text-ink",
              )}
            >
              {answered[index] && <Check size={12} className={index === currentIndex ? "" : "text-success"} />}
              {tabLabel(question, index)}
            </button>
          ))}
        </div>
      )}

      <div key={currentIndex} className="animate-pop-in">
        <div className="mt-2 text-[15.5px] leading-relaxed text-ink">{current.question}</div>
        {current.multiSelect && !settled && (
          <div className="mt-0.5 text-[12.5px] text-ink-secondary">{t("question.multiHint")}</div>
        )}

        {!settled && (
          <div
            role={current.multiSelect ? "group" : "radiogroup"}
            aria-label={current.question}
            className="mt-3 flex flex-col gap-1.5"
          >
            {current.options.map((option) => {
              const picked = draft.picked.includes(option.label);
              return (
                <button
                  key={option.label}
                  type="button"
                  role={current.multiSelect ? "checkbox" : "radio"}
                  aria-checked={picked}
                  onClick={() => choose(option.label)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-2xl border px-3.5 py-2.5 text-start transition-[background-color,border-color,transform] duration-150 active:scale-[0.99]",
                    picked ? "border-ink/40 bg-raised-hover" : "border-hairline/50 hover:border-hairline hover:bg-raised-hover/60",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14.5px] font-medium text-ink">{option.label}</span>
                    {option.description && (
                      <span className="block text-[13px] leading-snug text-ink-secondary">{option.description}</span>
                    )}
                  </span>
                  <Marker checked={picked} multi={Boolean(current.multiSelect)} />
                </button>
              );
            })}
            <div
              className={cn(
                "mt-1 flex h-11 items-center gap-2 rounded-full border bg-app/50 pe-1 ps-4 transition-colors",
                draft.other ? "border-ink/40" : "border-hairline/50 focus-within:border-hairline",
              )}
            >
              <input
                value={draft.custom}
                maxLength={MAX_CUSTOM_ANSWER}
                aria-label={t("question.other")}
                onChange={(event) => type(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && complete) submit();
                }}
                placeholder={t("question.otherPlaceholder")}
                className="min-w-0 flex-1 bg-transparent text-[14.5px] text-ink placeholder:text-ink-secondary focus:outline-none"
              />
              <button
                type="button"
                onClick={submit}
                disabled={!complete}
                aria-label={questions.length > 1 ? t("question.submitAll") : t("question.submit")}
                title={questions.length > 1 ? t("question.submitAll") : t("question.submit")}
                className="flex size-9 shrink-0 items-center justify-center rounded-full bg-ink text-app transition-[opacity,transform] active:scale-95 disabled:cursor-not-allowed disabled:opacity-25"
              >
                <Check size={18} strokeWidth={2.5} />
              </button>
            </div>
          </div>
        )}
      </div>

      {settled && (
        <div className="mt-2.5 flex justify-end">
          <span className="flex max-w-full items-start gap-1.5 rounded-[18px] bg-raised-hover px-3.5 py-2 text-[14px] text-ink">
            <Check size={14} className="mt-[3px] shrink-0 text-success" />
            <span className="whitespace-pre-wrap break-words">
              {(() => {
                const answer = card.answeredText ?? sent;
                return answer ? answerWithoutPreamble(answer) : t("question.status.answered");
              })()}
            </span>
          </span>
        </div>
      )}
    </div>
  );
}

/** The tick at the end of an option row. Drawn rather than an <input> so the
 * whole row stays one button and the hit target is the row. */
function Marker({ checked, multi }: { checked: boolean; multi: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-5 shrink-0 items-center justify-center border transition-colors duration-150",
        multi ? "rounded-md" : "rounded-full",
        checked ? "border-ink bg-ink text-app" : "border-hairline",
      )}
    >
      {checked && <Check size={12} strokeWidth={3} />}
    </span>
  );
}
