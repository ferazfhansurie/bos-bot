// Accessories in a bot's avatar settings: one row per slot, each option shown
// on the bot itself wearing everything else it already has on.
import { cn } from "@/lib/cn";
import type { MausColor } from "@/lib/mascot";
import {
  MASCOT_ACCESSORIES,
  MASCOT_ACCESSORY_SLOTS,
  botMascotAccessories,
  type MascotAccessories,
  type MascotAccessorySlot,
} from "../../shared/mascot-accessories";
import type { MascotBodyId } from "../../shared/mascot-bodies";
import type { MascotEyes } from "../../shared/mascot-eyes";
import { MausAvatar } from "./Avatar";

const SLOT_LABEL = {
  head: "Head",
  eyes: "Eyes",
  mouth: "Mouth",
  neck: "Neck",
} satisfies Record<MascotAccessorySlot, string>;

function wearing(current: MascotAccessories | null, slot: MascotAccessorySlot, id: string | null): MascotAccessories | null {
  const next: Record<string, string> = { ...(current ?? {}) };
  if (id) next[slot] = id;
  else delete next[slot];
  return botMascotAccessories(next);
}

export function MascotAccessoryPicker({ color, bodyId, eyes, value, disabled, onChange }: {
  color: MausColor;
  bodyId: MascotBodyId | null | undefined;
  eyes: MascotEyes | null | undefined;
  value: MascotAccessories | null | undefined;
  disabled?: boolean;
  onChange: (next: MascotAccessories | null) => void;
}) {
  const current = botMascotAccessories(value);
  return (
    <>
      <div className="mb-2 mt-4 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
        Accessories
      </div>
      {MASCOT_ACCESSORY_SLOTS.map(slot => {
        const options = [null, ...MASCOT_ACCESSORIES.filter(a => a.slot === slot)];
        return (
          <div key={slot} className="mb-4 last:mb-0">
            <div className="mb-2 text-[12px] text-ink-secondary">{SLOT_LABEL[slot]}</div>
            <div className="grid grid-cols-4 gap-2">
              {options.map(option => {
                const worn = (current?.[slot] ?? null) === (option?.id ?? null);
                return (
                  <button
                    key={option?.id ?? "none"}
                    type="button"
                    disabled={disabled}
                    aria-pressed={worn}
                    aria-label={option ? `Wear the ${option.name.toLowerCase()}` : `No ${SLOT_LABEL[slot].toLowerCase()} accessory`}
                    data-accessory-option={option?.id ?? `none-${slot}`}
                    onClick={() => { if (!worn) onChange(wearing(current, slot, option?.id ?? null)); }}
                    className={cn(
                      "flex min-w-0 flex-col items-center justify-center rounded-lg px-1 pb-2 pt-3 disabled:opacity-50",
                      worn ? "bg-control text-ink ring-1 ring-accent-border" : "text-ink-secondary hover:bg-control/60",
                    )}
                  >
                    <MausAvatar
                      color={color}
                      bodyId={bodyId ?? undefined}
                      eyes={eyes}
                      accessories={wearing(current, slot, option?.id ?? null)}
                      size={44}
                      animated={false}
                      trackPointer={false}
                    />
                    <span className="mt-1 max-w-full break-words text-center text-[11px] leading-tight">{option?.name ?? "None"}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </>
  );
}
