// One openui block drawn with the bos library. Pure: no app store, so the
// chat (SmartUiBlock) and the phone webview bundle (embed.tsx) share it.
// A settled block that yields no root, or throws while drawing, shows its
// fallback instead; while streaming an empty root just means "not yet".
import { createParser } from "@openuidev/lang-core";
import { Renderer, type ActionEvent } from "@openuidev/react-lang";
import { Component, useCallback, useEffect, useMemo, type ReactNode } from "react";
import { library } from "./library";
import "./components/theme.css";
import "./components/components.css";

export type SmartUiTheme = "light" | "dark";

export interface SmartUiProps {
  code: string;
  streaming: boolean;
  theme: SmartUiTheme;
  initialState?: Record<string, unknown>;
  onState?: (state: Record<string, unknown>) => void;
  /** @ToAssistant: text to post as the person's next message. */
  onAssistant?: (text: string) => void;
  onOpenUrl?: (url: string) => void;
  /** Shown when the block can't be drawn (also told via onFail). */
  fallback: ReactNode;
  onFail?: () => void;
}

/** "label: value" lines for a Form's fields, so a bot reads what was typed. */
export function formLines(event: Pick<ActionEvent, "formName" | "formState">): string {
  if (!event.formName || !event.formState) return "";
  const form = event.formState[event.formName];
  if (!form || typeof form !== "object") return "";
  const value = (field: unknown) => (field && typeof field === "object" && "value" in field ? (field as { value: unknown }).value : field);
  return Object.entries(form as Record<string, unknown>)
    .map(([name, field]) => [name, value(field)] as const)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([name, v]) => `${name}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join("\n");
}

/** The message @ToAssistant (or a bare Button) posts. */
export function assistantText(event: ActionEvent): string {
  const lines = formLines(event);
  const said = event.humanFriendlyMessage.trim();
  return lines ? `${said}\n\n${lines}`.trim() : said;
}

/** Stable per-block key: a block's code is fixed once the reply settles. */
export function smartUiKey(code: string): string {
  let h = 5381;
  for (let i = 0; i < code.length; i++) h = ((h << 5) + h + code.charCodeAt(i)) | 0;
  return `b${(h >>> 0).toString(36)}`;
}

const parser = createParser(library.toJSONSchema(), "Col");

/** Whether code draws anything: a root component after parsing. */
export function drawable(code: string): boolean {
  try { return Boolean(parser.parse(code).root); } catch { return false; }
}

const safeUrl = (url: unknown) => (typeof url === "string" && /^https?:\/\//i.test(url) ? url : null);

class DrawBoundary extends Component<{ fallback: ReactNode; onFail?: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onFail?.(); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function Failed({ fallback, onFail }: { fallback: ReactNode; onFail?: () => void }) {
  useEffect(() => { onFail?.(); }, [onFail]);
  return <>{fallback}</>;
}

export function SmartUi({ code, streaming, theme, initialState, onState, onAssistant, onOpenUrl, fallback, onFail }: SmartUiProps) {
  // while streaming, nothing to draw yet just means the root hasn't arrived
  const failed = useMemo(() => !streaming && !drawable(code), [code, streaming]);
  const onAction = useCallback((event: ActionEvent) => {
    if (event.type === "open_url") {
      const url = safeUrl(event.params.url);
      if (url) onOpenUrl?.(url);
      return;
    }
    if (event.type === "continue_conversation") {
      const text = assistantText(event);
      if (text) onAssistant?.(text);
    }
  }, [onAssistant, onOpenUrl]);
  if (failed) return <Failed fallback={fallback} onFail={onFail} />;
  return (
    <DrawBoundary fallback={fallback} onFail={onFail}>
      <div className="bos-openui" data-theme={theme} dir="ltr">
        <Renderer
          response={code}
          library={library}
          isStreaming={streaming}
          initialState={initialState}
          onStateUpdate={onState}
          onAction={onAction}
        />
      </div>
    </DrawBoundary>
  );
}
