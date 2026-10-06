import { BotAvatar } from "./Avatar";
import { cn } from "@/lib/cn";
import { normalizeState } from "@/lib/mascot";
import { roomMemberStatus, roomMemberStatusLabel, roomRosterPreview, type RoomViewFields } from "@/lib/room-view";
import type { Bot } from "@/state/store";

// Static profile avatars, stacked: working bots first with a ring + dot,
// the rest folded into a "+n" count so a big room stays one tidy chip.
export function RoomRoster({ room, members, max, showWorking = true }: { room: RoomViewFields & { busyBotId?: string | null }; members: Bot[]; max?: number; showWorking?: boolean }) {
  const roster = roomRosterPreview(members, (member) => roomMemberStatus(room, member), max);
  const workingCount = members.filter((member) => roomMemberStatus(room, member) === "working").length;
  return (
    <span className="flex items-center -space-x-1.5">
      {roster.visible.map((member, index) => {
        const status = roomMemberStatus(room, member);
        return <span key={member.id} title={`${member.name} — ${roomMemberStatusLabel(status, member)}`} aria-label={`${member.name}: ${roomMemberStatusLabel(status, member)}`} style={{ zIndex: roster.visible.length - index }} className={cn("relative inline-flex rounded-full ring-2 ring-app", status === "working" && "bot-morph ring-accent/60", status === "offline" && "opacity-50")}>
          <BotAvatar bot={member} state={normalizeState(member.mascotExpression) ?? "happy"} size={24} animated={false} />
          {status === "working" && <span className="absolute -right-0.5 -top-0.5 size-2 animate-pulse rounded-full border border-app bg-accent" />}
        </span>;
      })}
      {roster.rest.length > 0 && (
        <span title={roster.rest.map((member) => member.name).join(", ")} className="relative inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-raised px-1.5 text-[11px] font-medium tabular-nums text-ink-secondary ring-2 ring-app">
          +{roster.rest.length}
        </span>
      )}
      {showWorking && workingCount > 0 && (
        <span className="!ml-2.5 whitespace-nowrap text-[11.5px] text-accent">{workingCount} working</span>
      )}
    </span>
  );
}
