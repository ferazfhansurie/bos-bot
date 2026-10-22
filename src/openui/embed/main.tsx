// The phone webview's renderer: one ```chart, ```stats or ```openui block,
// drawn with the same components the desktop chat uses. Native calls
// window.bosSmartUI.render({ lang, code, streaming, theme, states }) and
// listens on the "bosSmartUI" bridge (webkit message handler on ios,
// BosSmartUI.post on android) for ready, height, state, assistant, openUrl
// and failed. No network: the page's CSP allows inline code and data: only.
import { createRoot } from "react-dom/client";
import { useLayoutEffect, useRef, useState } from "react";
import { SmartUi, smartUiKey, type SmartUiTheme } from "../SmartUi";
import { RichChart } from "../../components/RichChart";
import { parseChartSpec } from "../../components/rich-chart";
import { parseStats, StatCards } from "../../components/RichStats";
import "./embed.css";

export interface EmbedPayload {
  lang: string;
  code: string;
  streaming?: boolean;
  theme?: SmartUiTheme;
  /** The message's uiState: saved values for each of its blocks, by key. */
  states?: Record<string, Record<string, unknown>>;
}

type Outbound =
  | { type: "ready" }
  | { type: "height"; value: number }
  | { type: "state"; key: string; state: Record<string, unknown> }
  | { type: "assistant"; text: string }
  | { type: "openUrl"; url: string }
  | { type: "failed" };

function post(message: Outbound) {
  const w = window as unknown as {
    webkit?: { messageHandlers?: { bosSmartUI?: { postMessage(m: unknown): void } } };
    BosSmartUI?: { post(json: string): void };
  };
  w.webkit?.messageHandlers?.bosSmartUI?.postMessage(message);
  w.BosSmartUI?.post(JSON.stringify(message));
}

function Failed() {
  useLayoutEffect(() => post({ type: "failed" }), []);
  return null;
}

function Preparing() {
  return <div role="status" className="rounded-2xl border border-hairline p-4 text-ink-secondary">Preparing visual…</div>;
}

function Block({ payload }: { payload: EmbedPayload }) {
  const { code, streaming = false, theme = "light", states } = payload;
  const lang = payload.lang.toLowerCase();
  if (lang === "chart" || lang === "stats") {
    const chart = lang === "chart" ? parseChartSpec(code) : null;
    const stats = lang === "stats" ? parseStats(code) : null;
    if (chart) return <RichChart spec={chart} />;
    if (stats) return <StatCards items={stats} />;
    return streaming ? <Preparing /> : <Failed />;
  }
  const key = smartUiKey(code);
  return (
    <SmartUi
      code={code}
      streaming={streaming}
      theme={theme}
      initialState={states?.[key]}
      onState={(next) => post({ type: "state", key, state: next })}
      onAssistant={(text) => post({ type: "assistant", text })}
      onOpenUrl={(url) => post({ type: "openUrl", url })}
      fallback={null}
      onFail={() => post({ type: "failed" })}
    />
  );
}

function App() {
  const [payload, setPayload] = useState<EmbedPayload | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    (window as unknown as { bosSmartUI: { render(p: EmbedPayload): void } }).bosSmartUI = {
      render(next) {
        document.documentElement.dataset.theme = next.theme === "dark" ? "dark" : "light";
        setPayload(next);
      },
    };
    post({ type: "ready" });
    const el = ref.current!;
    let last = -1;
    const observer = new ResizeObserver(() => {
      const value = Math.ceil(el.getBoundingClientRect().height);
      if (value !== last) { last = value; post({ type: "height", value }); }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return <div ref={ref}>{payload && <Block payload={payload} />}</div>;
}

createRoot(document.getElementById("root")!).render(<App />);
