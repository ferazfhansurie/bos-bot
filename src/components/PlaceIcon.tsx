import { Box, Cloud, Globe, Monitor, Power, Sparkles, type LucideProps } from "lucide-react";
import type { EffectivePlace } from "@/lib/place";
import { BoxComputeMark } from "./BoxComputeMark";

/** The same icon for a place everywhere: picker, chip, tab, tool row. */
const ICONS = { cloud: Cloud, vm: Box, local: Monitor, browser: Globe, auto: Sparkles, off: Power, boxcompute: BoxComputeMark } as const;

export function PlaceIcon({ place, ...props }: { place: EffectivePlace } & LucideProps) {
  if (place === "boxcompute") return <BoxComputeMark size={props.size} className={props.className} aria-hidden={props["aria-hidden"]} />;
  const Icon = ICONS[place];
  return <Icon {...props} />;
}
