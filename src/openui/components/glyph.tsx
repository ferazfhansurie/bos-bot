import { AlertTriangle, CheckCircle, Info, type LucideIcon } from "lucide-react";

// Only the icons the components draw themselves; bots don't pick icons, so
// the phone renderer stays one small file.
const ICONS: Record<string, LucideIcon> = { info: Info, "check-circle": CheckCircle, "alert-triangle": AlertTriangle };

export function Glyph({ name, size = 18, className }: { name: string; size?: number; className?: string }) {
  const Icon = ICONS[name];
  return Icon ? <Icon size={size} strokeWidth={1.8} aria-hidden className={className} /> : null;
}
