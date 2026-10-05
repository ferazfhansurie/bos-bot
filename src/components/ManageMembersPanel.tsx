// Edit an existing room's roster: the same picker "New Room" uses, opened
// from the member mauses in the room header and pre-ticked with who is
// already in. Membership is the only thing this touches — the transcript
// keeps every message a departing bot already sent. People are listed
// below the bots and, unlike the bot picker, apply one by one: each add or
// remove is its own request, so there is nothing for Save to batch.
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Link, UserPlus, X } from "lucide-react";
import { track } from "@/lib/analytics";
import { useMultiplayerMe } from "@/lib/room-sender";
import { api, useStore, type Group, type RoomPerson } from "@/state/store";
import { PersonFace } from "./Avatar";
import { BotPickerList } from "./BotPickerList";
import { InviteLink } from "./SharedContactsSidebar";
import { nextMemberIds } from "@/lib/room-members";

/** A `/api/multiplayer/contacts` row; only people can join a room's roster. */
export interface RoomContact {
  id: string;
  name: string;
  kind: "person" | "bot";
  homeId?: string;
  homeName?: string;
  avatar?: string | null;
  color?: string | null;
}

/** People you could add: contacts who are people, not you, not already in. */
export function roomPersonCandidates(
  contacts: RoomContact[],
  people: Pick<RoomPerson, "id">[],
  meId: string | null | undefined,
): RoomContact[] {
  const inRoom = new Set(people.map((person) => person.id));
  return contacts.filter((contact) => contact.kind === "person" && contact.id !== meId && !inRoom.has(contact.id));
}

/** The room's home owner — implicit, so never removable. Falls back to the
 * id shape when the room's home isn't known yet. */
export function isRoomOwner(personId: string, roomHomeId: string | undefined): boolean {
  return roomHomeId ? personId === `${roomHomeId}:person:owner` : personId.endsWith(":person:owner");
}

export function ManageMembersPanel({
  group,
  onClose,
  triggerRef,
}: {
  group: Group;
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const { state, dispatch } = useStore();
  const [picked, setPicked] = useState<Set<string>>(() => new Set(group.memberIds));
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const openedMemberIds = useRef([...group.memberIds]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const me = useMultiplayerMe();
  const [contacts, setContacts] = useState<RoomContact[]>([]);
  const [adding, setAdding] = useState(false);
  const [confirmPersonId, setConfirmPersonId] = useState<string | null>(null);
  const [peopleBusy, setPeopleBusy] = useState(false);
  const [peopleError, setPeopleError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  // A guest in another home's room, or a bot⇄bot channel, can only look.
  const canManagePeople = !group.home && !group.dm;
  const multiplayer = Boolean(me?.actorId);
  const people = group.people ?? [];
  const roomHomeId = group.home?.id ?? me?.homeId;

  // Archived bots stay listed while they are still members — otherwise a
  // room could keep a member you have no way to remove.
  const bots = useMemo(
    () => state.bots.filter((b) => !b.hidden || group.memberIds.includes(b.id)),
    [state.bots, group.memberIds],
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = () =>
      [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(
        (element) => !element.hasAttribute("hidden"),
      );
    focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (!controls.length) return event.preventDefault();
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", onKey);
    return () => {
      dialog.removeEventListener("keydown", onKey);
      triggerRef.current?.focus();
    };
  }, [onClose, triggerRef]);

  useEffect(() => {
    if (!canManagePeople || !multiplayer) return;
    let alive = true;
    api<{ contacts: RoomContact[] }>("/api/multiplayer/contacts").then(
      (result) => { if (alive) setContacts(result.contacts ?? []); },
      (error) => { if (alive) setPeopleError(error instanceof Error ? error.message : String(error)); },
    );
    return () => { alive = false; };
  }, [canManagePeople, multiplayer]);

  const candidates = roomPersonCandidates(contacts, people, me?.actorId);

  // Shared by add, remove and invite: one request at a time, errors inline.
  const runPeople = async (work: () => Promise<void>) => {
    setPeopleBusy(true);
    setPeopleError(null);
    try {
      await work();
    } catch (error) {
      setPeopleError(error instanceof Error ? error.message : String(error));
    } finally { setPeopleBusy(false); }
  };

  const addPerson = (personId: string) => runPeople(async () => {
    const result: { group: Group } = await api(`/api/groups/${group.id}/people`, { method: "POST", body: JSON.stringify({ personId }) });
    dispatch({ type: "groupPatched", group: result.group });
    setAdding(false);
  });

  const removePerson = (personId: string) => runPeople(async () => {
    const result: { group: Group } = await api(`/api/groups/${group.id}/people/${encodeURIComponent(personId)}`, { method: "DELETE" });
    dispatch({ type: "groupPatched", group: result.group });
    setConfirmPersonId(null);
  });

  const createInvite = () => runPeople(async () => {
    const result: { url: string; expiresAt: number } = await api("/api/multiplayer/invites", { method: "POST", body: JSON.stringify({ roomIds: [group.id] }) });
    setInviteUrl(result.url);
  });

  const toggle = (id: string) => {
    setConfirmRemoval(false);
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const memberIds = nextMemberIds(
    group.memberIds,
    picked,
    bots.map((b) => b.id),
  );
  const changed = memberIds.length !== group.memberIds.length || memberIds.some((id, i) => id !== group.memberIds[i]);

  const removed = group.memberIds.filter(id => !memberIds.includes(id));
  const save = async () => {
    if (!memberIds.length) return;
    const opened = openedMemberIds.current;
    const rosterChanged =
      opened.length !== group.memberIds.length || opened.some((id, index) => id !== group.memberIds[index]);
    if (rosterChanged) {
      setSaveError("This group's members changed while the panel was open. Close it and try again.");
      return;
    }
    if (removed.length && !confirmRemoval) {
      setConfirmRemoval(true);
      return;
    }
    setSaving(true);
    try {
      if (changed) {
        const result: { group: Group } = await api(`/api/groups/${group.id}`, { method: "PATCH", body: JSON.stringify({ memberIds }) });
        dispatch({ type: "groupPatched", group: result.group });
        track("room_members_changed", {
          members: memberIds.length,
          added: memberIds.filter((id) => !group.memberIds.includes(id)).length,
          removed: group.memberIds.filter((id) => !memberIds.includes(id)).length,
        });
      }
      onClose();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally { setSaving(false); }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Manage members of ${group.name}`}
        className="max-h-[85vh] w-[340px] overflow-y-auto rounded-2xl border border-hairline/50 bg-card p-4 shadow-2xl"
      >
        <div className="mb-1 text-[15px] font-semibold text-ink">Manage Members</div>
        <div className="mb-3 truncate text-[13px] text-ink-secondary">{group.name}</div>
        <BotPickerList bots={bots} picked={picked} onToggle={toggle} emptyHint="Create a bot first — groups are made of bots." />
        {!memberIds.length && <div className="mt-2 text-[12px] text-ink-secondary">A group needs at least one bot.</div>}
        {confirmRemoval && <p role="alert" className="mt-2 text-[12px] text-ink-secondary">Remove {removed.length} {removed.length === 1 ? "member" : "members"}? Their messages stay in this room.</p>}
        <div className="mt-3 border-t border-hairline/40 pt-3">
          <div className="mb-1 flex items-center gap-2">
            <span className="flex-1 text-[13px] font-semibold text-ink">People</span>
            {canManagePeople && multiplayer && (
              <button
                type="button"
                aria-expanded={adding}
                onClick={() => setAdding((open) => !open)}
                className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-medium hover:bg-raised ${adding ? "text-accent" : "text-ink-secondary hover:text-ink"}`}
              >
                <UserPlus size={13} />Add person
              </button>
            )}
            {canManagePeople && (
              <button
                type="button"
                disabled={peopleBusy}
                onClick={() => void createInvite()}
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-medium text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
              >
                <Link size={13} />Invite link
              </button>
            )}
          </div>
          {people.map((person) => {
            const owner = isRoomOwner(person.id, roomHomeId);
            return (
              <div key={person.id}>
                <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
                  <PersonFace person={person} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] text-ink">{person.name}</span>
                    {me && person.homeName && person.homeId !== me.homeId && (
                      <span className="block truncate text-[11px] text-ink-secondary">{person.homeName}</span>
                    )}
                  </span>
                  {owner && <span className="shrink-0 rounded bg-raised px-1.5 py-0.5 text-[11px] text-ink-secondary">Owner</span>}
                  {!owner && canManagePeople && (
                    <button
                      type="button"
                      aria-label={`Remove ${person.name}`}
                      disabled={peopleBusy}
                      onClick={() => setConfirmPersonId(person.id)}
                      className="flex size-6 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
                {confirmPersonId === person.id && (
                  <div className="mb-1 flex items-center gap-2 px-2">
                    <p role="alert" className="min-w-0 flex-1 text-[12px] text-ink-secondary">Remove {person.name}? Their messages stay in this room.</p>
                    <button type="button" onClick={() => setConfirmPersonId(null)} className="shrink-0 rounded-md bg-raised px-2 py-0.5 text-[12px] text-ink hover:brightness-110">
                      Keep
                    </button>
                    <button
                      type="button"
                      disabled={peopleBusy}
                      onClick={() => void removePerson(person.id)}
                      className="shrink-0 rounded-md bg-danger px-2 py-0.5 text-[12px] text-white hover:brightness-110 disabled:opacity-40"
                    >
                      Remove
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          {people.length <= 1 && canManagePeople && (
            <div className="px-2 py-1 text-[12px] text-ink-secondary">Share an invite link to bring people into this room.</div>
          )}
          {adding && multiplayer && (
            <div className="mt-1 flex max-h-40 flex-col gap-0.5 overflow-y-auto rounded-lg bg-raised/40 p-1">
              {candidates.length === 0 && <div className="px-2 py-2 text-[12px] text-ink-secondary">No one else to add yet — share an invite link.</div>}
              {candidates.map((contact) => (
                <button
                  key={contact.id}
                  type="button"
                  disabled={peopleBusy}
                  aria-label={`Add ${contact.name}`}
                  onClick={() => void addPerson(contact.id)}
                  className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-raised disabled:opacity-40"
                >
                  <PersonFace person={contact} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] text-ink">{contact.name}</span>
                    {me && contact.homeName && contact.homeId !== me.homeId && (
                      <span className="block truncate text-[11px] text-ink-secondary">{contact.homeName}</span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
          {inviteUrl && <div className="mt-1.5 text-[12px]"><InviteLink link={inviteUrl} /></div>}
          {peopleError && (
            <div role="alert" className="mt-2 text-[12px] text-danger">
              {peopleError}
            </div>
          )}
        </div>
        {saveError && (
          <div role="alert" className="mt-2 text-[12px] text-danger">
            {saveError}
          </div>
        )}
        <div className="mt-3 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 rounded-lg bg-raised py-2 text-[14px] font-medium text-ink hover:brightness-110"
          >
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={!memberIds.length || saving}
            className="flex-1 rounded-lg bg-accent py-2 text-[14px] font-medium text-white hover:brightness-110 disabled:opacity-40"
          >
            {saving ? "Saving…" : confirmRemoval ? "Confirm removal" : `Save${memberIds.length ? ` · ${memberIds.length} ${memberIds.length === 1 ? "bot" : "bots"}` : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}
