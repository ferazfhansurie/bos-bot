import { useEffect, useState } from "react";

// Only the hosted gateway serves this route. Desktop and other servers never poll it.
export function HostedNextStep() {
  const [show, setShow] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (dismissed || !/^https:$/.test(location.protocol) || !/^[a-z][a-z0-9-]{1,30}\.bosbot\.my$/.test(location.hostname) || location.hostname === "app.bosbot.my") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch("/__bos/offer/status", { cache: "no-store", signal: AbortSignal.timeout(8000) });
        if (response.status === 401 || response.status === 403 || response.status === 404) return;
        if (!response.ok) throw new Error("temporarily unavailable");
        const result = await response.json();
        if (!stopped && result.ready === true && result.confirmed !== true) setShow(true);
        if (result.confirmed === true) return;
      } catch { /* an optional next step must never block chat */ }
      if (!stopped) timer = setTimeout(poll, 30_000);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [dismissed]);
  if (!show || dismissed) return null;
  return <aside aria-label="keep working with bos" className="fixed right-4 top-16 z-40 max-w-[calc(100vw-2rem)] rounded-xl border border-hairline bg-panel p-4 shadow-lg">
    <p className="mb-2 text-sm text-ink">got a useful result?</p>
    <div className="flex items-center gap-3 text-sm">
      <a href="/__bos/offer" className="font-medium text-ink underline">desktop download and cloud options</a>
      <button type="button" aria-label="dismiss next step" className="text-ink-secondary" onClick={() => setDismissed(true)}>later</button>
    </div>
  </aside>;
}
