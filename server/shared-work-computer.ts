import { z } from "zod";

/** A saved identity, never an address supplied to a tool or a hostname match. */
export const sharedWorkComputerSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
}).strict();
export type SharedWorkComputer = z.infer<typeof sharedWorkComputerSchema>;
const failure = (message: string, code: string, status = 409) => Object.assign(new Error(message), { status, code });

export function admitSharedWorkComputer(
  target: unknown,
  computers: readonly { id: string; terminal: boolean }[],
  enabled: boolean,
  isolated: boolean,
): SharedWorkComputer {
  const parsed = sharedWorkComputerSchema.safeParse(target);
  if (!parsed.success) throw failure("The saved work computer is invalid. Review this bot's settings; no local work was started.", "work_computer_invalid");
  const selected = parsed.data;
  if (!enabled) throw failure(`Work paused: computer sharing is disabled. ${selected.name} remains selected; this Mac will not be used.`, "work_computer_disabled");
  if (!isolated) throw failure("Work paused: this provider cannot disable native Mac tools for a shared work computer. No fallback was started.", "work_computer_provider");
  const computer = computers.find(entry => entry.id === selected.id);
  if (!computer) throw failure(`Work paused: ${selected.name} is offline or no longer shared. Reconnect it; this Mac will not be used.`, "work_computer_offline");
  if (!computer.terminal) throw failure(`Work paused: ${selected.name} has no terminal grant. Review access on that computer; no fallback was started.`, "work_computer_grant");
  return selected;
}

export function assertSharedWorkComputerOperation(pinned: SharedWorkComputer, current: unknown, requestedId: string): void {
  const parsed = sharedWorkComputerSchema.safeParse(current);
  if (!parsed.success || parsed.data.id !== pinned.id || requestedId !== pinned.id) {
    throw failure("The work computer changed or this operation targets another computer. Start a new turn; no operation was sent.", "work_computer_changed");
  }
}
