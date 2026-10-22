import { useAppConfig } from "@/lib/app-config";

export function ProductBanner() {
  const { banner } = useAppConfig();
  if (!banner) return null;
  return <aside aria-label="BOS announcement" className="shrink-0 border-b border-accent/20 bg-accent/10 px-4 py-2 text-center text-xs text-ink">
    <a href={banner.url} target="_blank" rel="noreferrer" className="break-words underline decoration-accent/40 underline-offset-2 hover:decoration-accent">{banner.text}</a>
  </aside>;
}
