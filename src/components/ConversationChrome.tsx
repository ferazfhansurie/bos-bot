import type { CSSProperties, ReactNode } from "react";

/** Common visual shell for local and federated conversations. */
export function ConversationHeader({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={style} className="@container/chathead flex items-center justify-between px-5 py-3 pl-11 md:pl-5">{children}</div>;
}

export function ConversationComposerFrame({ children }: { children: ReactNode }) {
  return <div data-tour="composer" className="relative z-[1] rounded-3xl bg-composer px-2 py-1.5 ring-1 ring-composer-ring">{children}</div>;
}

export function conversationBubbleClass(mine: boolean) {
  return `w-fit max-w-[min(42rem,78%)] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed text-ink ${mine ? "bg-bubble-user whitespace-pre-wrap" : "bg-card"}`;
}
