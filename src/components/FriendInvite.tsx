// Friends on other computers meet through the BOS Bot people service
// (server/people-hub.ts): an invite link or email from here, a pasted link
// there, and both people land in a direct chat with each other.
import { useEffect, useState } from "react";
import { UserPlus, X } from "lucide-react";
import { api, useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { InviteLink } from "./SharedContactsSidebar";

const INVITE_PARAM = /^[\w-]{10,64}$/;

/** Accept an invite and open the chat it made with the friend. */
async function joinWith(link: string): Promise<string | null> {
  const result = await api<{ room?: { id: string } }>("/api/people-hub/accept", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ link }),
  });
  window.dispatchEvent(new Event("multiplayer:refresh"));
  return result.room?.id ?? null;
}

/** `?invite=` in the address (the invite page's browser button) joins once,
 * then leaves the address clean so a reload doesn't try again. */
export function useInviteFromAddress() {
  const { dispatch } = useStore();
  useEffect(() => {
    const url = new URL(window.location.href);
    const fromHash = new URLSearchParams(url.hash.slice(1)).get("invite");
    const token = url.searchParams.get("invite") ?? fromHash;
    if (!token || !INVITE_PARAM.test(token)) return;
    url.searchParams.delete("invite");
    if (fromHash) url.hash = "";
    window.history.replaceState(window.history.state, "", url.toString());
    void joinWith(token).then(roomId => { if (roomId) dispatch({ type: "selectSharedRoom", roomId }); }, () => {});
  }, [dispatch]);
  // the desktop app hands over bosbot://invite links after it joined
  useEffect(() => {
    const open = (event: Event) => {
      const roomId = (event as CustomEvent<unknown>).detail;
      if (typeof roomId === "string" && roomId) {
        window.dispatchEvent(new Event("multiplayer:refresh"));
        dispatch({ type: "selectSharedRoom", roomId });
      }
    };
    window.addEventListener("people-hub:joined", open);
    return () => window.removeEventListener("people-hub:joined", open);
  }, [dispatch]);
}

export function FriendInvitePanel({ onClose }: { onClose: () => void }) {
  const { dispatch } = useStore();
  const [email, setEmail] = useState("");
  const [link, setLink] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState<"invite" | "join" | null>(null);
  const [error, setError] = useState("");
  const run = async (kind: "invite" | "join", work: () => Promise<void>) => {
    setBusy(kind); setError("");
    try { await work(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Something went wrong. Try again."); }
    finally { setBusy(null); }
  };
  const invite = () => run("invite", async () => {
    const to = email.trim();
    const result = await api<{ url: string; emailed: boolean }>("/api/people-hub/invites", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(to ? { email: to } : {}),
    });
    setLink(result.url);
    setSentTo(result.emailed ? to : "");
    if (result.emailed) setEmail("");
  });
  const join = () => run("join", async () => {
    const roomId = await joinWith(paste.trim());
    setPaste("");
    if (roomId) dispatch({ type: "selectSharedRoom", roomId });
    onClose();
  });
  return <div role="region" aria-label="Add a friend" className="mx-1 mb-2 mt-2 space-y-3 rounded-xl bg-raised p-3 text-[13px]">
    <div className="flex items-center justify-between">
      <p className="font-semibold text-ink">Add a friend</p>
      <button type="button" aria-label="Close add a friend" onClick={onClose} className="rounded-md p-0.5 text-ink-secondary hover:bg-control hover:text-ink"><X size={14} /></button>
    </div>
    <p className="text-[12px] leading-relaxed text-ink-secondary">Chat one to one, start groups, and @mention your bots in the chat. Your bots, memory and files stay yours.</p>
    <form className="space-y-2" onSubmit={event => { event.preventDefault(); void invite(); }}>
      <input type="email" aria-label="Friend's email (optional)" placeholder="Friend's email (optional)" value={email} onChange={event => setEmail(event.target.value)}
        className="w-full rounded-lg bg-app px-2.5 py-1.5 text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-accent" />
      <button type="submit" disabled={busy !== null} className="w-full rounded-lg bg-accent py-1.5 font-medium text-white disabled:opacity-50">
        {busy === "invite" ? "Creating…" : email.trim() ? "Email invite" : "Create invite link"}
      </button>
    </form>
    {sentTo && <p role="status" className="text-[12px] text-success">Invite sent to {sentTo}.</p>}
    {link && <InviteLink link={link} />}
    <form className="space-y-2 border-t border-hairline/40 pt-3" onSubmit={event => { event.preventDefault(); if (paste.trim()) void join(); }}>
      <label htmlFor="friend-invite-paste" className="block text-[12px] font-medium text-ink-secondary">Got an invite link?</label>
      <input id="friend-invite-paste" placeholder="Paste it here" value={paste} onChange={event => setPaste(event.target.value)}
        className="w-full rounded-lg bg-app px-2.5 py-1.5 text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-accent" />
      <button type="submit" disabled={!paste.trim() || busy !== null} className="w-full rounded-lg bg-control py-1.5 font-medium text-ink disabled:opacity-50">
        {busy === "join" ? "Joining…" : "Join"}
      </button>
    </form>
    {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
  </div>;
}

/** The sidebar row that opens the panel. */
export function AddFriendButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return <button type="button" aria-expanded={open} onClick={onToggle} title="Invite a friend to chat"
    className={cn("mt-2 flex h-9 w-full items-center gap-2 rounded-[10px] px-2 text-left text-[13px] font-medium hover:bg-raised/40", open ? "text-accent" : "text-ink-secondary hover:text-ink")}>
    <UserPlus size={16} />Add a friend
  </button>;
}
