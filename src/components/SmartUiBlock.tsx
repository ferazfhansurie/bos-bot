// A ```openui block in a chat bubble: the shared SmartUi renderer plus what
// the chat adds. Theme follows the skin; typed and toggled values save onto
// the message (uiState, keyed per block) so a reload keeps them; buttons
// post into this same thread as the person.
import { useCallback, useEffect, useRef, useState } from "react";
import { SmartUi, smartUiKey, type SmartUiTheme } from "@/openui/SmartUi";

export { smartUiKey };
import { api, useStore } from "@/state/store";
import { CodeBlock } from "./ChatMarkdown";

export interface SmartUiMessage { threadId: string; messageId: string; uiState?: Record<string, Record<string, unknown>> }


// Live values outlive a remount (react-markdown rebuilds its components on
// every render), and beat the saved copy until the server echoes it back.
const live = new Map<string, Record<string, unknown>>();

function skinScheme(): SmartUiTheme {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--code-color-scheme").trim();
  if (value === "dark" || value === "light") return value;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function useSkinScheme(): SmartUiTheme {
  const [scheme, setScheme] = useState(skinScheme);
  useEffect(() => {
    const update = () => setScheme(skinScheme());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-skin", "data-theme", "style"] });
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);
    return () => { observer.disconnect(); media.removeEventListener("change", update); };
  }, []);
  return scheme;
}

export const SMART_UI_STATE_MAX = 16_000;

export default function SmartUiBlock({ code, streaming, message }: { code: string; streaming: boolean; message?: SmartUiMessage }) {
  const theme = useSkinScheme();
  const { state, dispatch } = useStore();
  const key = smartUiKey(code);
  const liveKey = message ? `${message.messageId}:${key}` : "";
  const [initialState] = useState(() => (liveKey && live.get(liveKey)) || message?.uiState?.[key]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  const onState = useCallback((next: Record<string, unknown>) => {
    if (!message || streaming) return;
    live.set(liveKey, next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const body = JSON.stringify({ key, state: next });
      if (body.length > SMART_UI_STATE_MAX) return;
      void api(`/api/threads/${encodeURIComponent(message.threadId)}/messages/${encodeURIComponent(message.messageId)}/ui`, { method: "POST", body }).catch(() => {});
    }, 600);
  }, [key, liveKey, message, streaming]);

  const onAssistant = useCallback((text: string) => {
    if (!message) return;
    const group = state.groups.find((g) => g.threadId === message.threadId);
    if (group) return dispatch({ type: "sendGroup", groupId: group.id, threadId: message.threadId, text });
    const bot = state.bots.find((b) => b.threadId === message.threadId);
    if (bot) dispatch({ type: "send", botId: bot.id, threadId: message.threadId, text });
  }, [dispatch, message, state.bots, state.groups]);

  const onOpenUrl = useCallback((url: string) => { window.open(url, "_blank", "noopener,noreferrer"); }, []);

  return (
    <figure dir="ltr" className="my-3 min-w-0">
      <SmartUi
        code={code}
        streaming={streaming}
        theme={theme}
        initialState={initialState}
        onState={onState}
        onAssistant={message ? onAssistant : undefined}
        onOpenUrl={onOpenUrl}
        fallback={(
          <div>
            <CodeBlock code={code} lang="openui" streaming={false} />
            <figcaption className="mt-1 text-[12px] text-ink-secondary">couldn't draw this</figcaption>
          </div>
        )}
      />
    </figure>
  );
}
