import { Component, type ErrorInfo, type ReactNode } from "react";
import { brand } from "@/lib/brand";
import { t } from "@/lib/i18n";

/** What the person sees instead of a blank window when the UI itself
 * crashed. Plain words, one obvious way back. Nothing here may depend on the
 * store or the server: they may be what broke. */
export function AppCrashScreen({ detail, onReload }: { detail?: string; onReload: () => void }) {
  const { name, logo } = brand();
  return (
    <div role="alert" className="flex min-h-screen items-center justify-center bg-app px-6 text-ink" data-app-crash>
      <div className="w-full max-w-[420px] text-center">
        {logo ? (
          <img src={logo} alt="" className="mx-auto mb-5 h-12 w-12 rounded-xl" />
        ) : (
          <div aria-hidden className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-accent text-[15px] font-bold tracking-wide text-white">
            BOS
          </div>
        )}
        <h1 className="text-[19px] font-semibold">{t("appCrash.title", { app: name })}</h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-secondary">{t("appCrash.body")}</p>
        <button
          type="button"
          onClick={onReload}
          autoFocus
          className="mt-6 rounded-lg bg-accent px-5 py-2 text-[13.5px] font-semibold text-white hover:brightness-110"
        >
          {t("appCrash.reload")}
        </button>
        {detail ? (
          <details className="mt-6 text-left text-[12px] text-ink-secondary">
            <summary className="cursor-pointer select-none">{t("appCrash.details")}</summary>
            <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-card p-3 font-mono text-[11.5px] whitespace-pre-wrap">{detail}</pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}

/** Top-level boundary: one bad render anywhere (a room's markdown, a card)
 * must not leave an empty window with cmd-R as the only way back. */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("[bos] the app crashed while rendering", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return <AppCrashScreen detail={this.state.error.message} onReload={() => window.location.reload()} />;
    }
    return this.props.children;
  }
}
