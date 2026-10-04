// Updates as a row of their own, directly under Tools.
//
// Checking for updates used to be buried in the profile menu, two clicks
// away, with only a small badge on the profile row when something was
// happening. It is now always visible: the row names its current state
// ("Check for updates", "Downloading… 40%", "Version 1.4 ready — restart")
// and a click does the next thing. Absent in dev, where there is no updater.
import { cn } from "@/lib/cn";
import { UpdateIcon, useUpdateItem } from "./SidebarProfileMenu";

export function SidebarUpdateRow({ compact = false }: { compact?: boolean }) {
  const update = useUpdateItem();
  if (!update) return null;
  const { item, phase, pending, label } = update;
  const tone = phase === "error" ? "text-danger" : item.attention ? "text-accent" : "text-ink-secondary";
  return (
    <button
      type="button"
      data-tour="update"
      disabled={item.disabled}
      onClick={item.onSelect}
      title={label}
      className={cn(
        "flex min-h-9 w-full items-center gap-3 rounded-xl px-3 text-left text-[14px] text-ink transition-colors",
        compact ? "py-1" : "py-1.5",
        "hover:bg-raised/50 disabled:cursor-default disabled:hover:bg-transparent",
      )}
    >
      <span className={tone}>
        <UpdateIcon phase={phase} pending={pending} />
      </span>
      <span className="flex-1 truncate">{label}</span>
      {item.attention && (
        <span className={cn("size-2 shrink-0 rounded-full", phase === "error" ? "bg-danger" : "bg-accent")} />
      )}
    </button>
  );
}
