// The voice chat card (contract §10): what a call said and did, in the
// "voice chat" thread the server writes when the call ends.

import { AudioLines, ChevronRight, ThumbsDown, ThumbsUp } from "lucide-react";
import { useState } from "react";

import type { VoiceCallCard as VoiceCallCardData } from "../../../shared/voice-call";
import { formatCallDuration } from "@/lib/voice-call/protocol";
import { api, openNotificationTarget, useStore } from "@/state/store";

type Rating = "good" | "bad";

export function VoiceCallCard({ card }: { card: VoiceCallCardData }) {
  const { state, dispatch } = useStore();
  // The stored card is updated by the server; this makes the tap show at once.
  const [chosen, setChosen] = useState<Rating | undefined>(card.rating);
  const [open, setOpen] = useState(false);
  const rating = chosen ?? card.rating;

  function rate(good: boolean) {
    const next: Rating = good ? "good" : "bad";
    if (rating === next) return;
    const before = chosen;
    setChosen(next);
    api("/api/voice/call/event", {
      method: "POST",
      body: JSON.stringify({ callId: card.callId, botId: card.botId, event: { kind: "rating", good } }),
      timeoutMs: 8_000,
    }).catch(() => setChosen(before));
  }

  return (
    <div data-voice-chat-card className="my-1 max-w-[34rem] rounded-2xl border border-line bg-raised/60 px-4 py-3 text-[14px] text-ink">
      <div className="flex items-center gap-2 text-ink-secondary">
        <AudioLines size={15} aria-hidden="true" />
        <span className="font-medium tabular-nums">voice chat · {formatCallDuration(card.seconds * 1000)}</span>
      </div>
      {card.summary && <p className="mt-1.5 leading-snug">{card.summary}</p>}
      {card.jobs.length > 0 && (
        <ul className="mt-2 space-y-1">
          {card.jobs.map((job) => {
            const threadId = job.threadId;
            const body = (
              <>
                <span className="min-w-0 flex-1 truncate">{job.text}</span>
                <span className="shrink-0 text-[12px] text-ink-secondary">{job.status}</span>
                {threadId && <ChevronRight size={14} className="shrink-0 text-ink-secondary" aria-hidden="true" />}
              </>
            );
            return (
              <li key={job.jobId}>
                {threadId ? (
                  <button
                    type="button"
                    onClick={() => openNotificationTarget(dispatch, { botId: job.botId ?? card.botId, threadId }, state)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-raised-hover"
                  >
                    {body}
                  </button>
                ) : (
                  <div className="flex w-full items-center gap-2 px-2 py-1">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {card.transcript.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            className="flex items-center gap-1 text-[12px] text-ink-secondary hover:text-ink"
          >
            <ChevronRight size={13} className={open ? "rotate-90 transition-transform" : "transition-transform"} aria-hidden="true" />
            transcript
          </button>
          {open && (
            <div className="mt-1 space-y-1 text-[13px]">
              {card.transcript.map((line, index) => (
                <p key={`${line.at ?? index}-${index}`} className={line.role === "user" ? "text-ink" : "text-ink-secondary"}>
                  <span className="text-ink-secondary">{line.role === "user" ? "you" : "bot"}: </span>
                  {line.text}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="mt-2 flex items-center gap-1">
        <RatingButton label="good call" active={rating === "good"} onClick={() => rate(true)}>
          <ThumbsUp size={14} />
        </RatingButton>
        <RatingButton label="bad call" active={rating === "bad"} onClick={() => rate(false)}>
          <ThumbsDown size={14} />
        </RatingButton>
      </div>
    </div>
  );
}

function RatingButton({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={`flex size-7 items-center justify-center rounded-full ${active ? "bg-ink text-app" : "text-ink-secondary hover:bg-raised-hover hover:text-ink"}`}
    >
      {children}
    </button>
  );
}
