// Who wrote a user-role line in a room.
//
// A room used to hold one person, so every user line was "you" and sat on
// the right. Rooms now carry people (Group.peopleIds), and the server stamps
// each user message with the authenticated `sender`. A line is yours when
// its sender is your actor; a line with no sender predates the stamp and
// belongs to the room's home owner — you on a room you host, the host on a
// room you opened from another home.
import { useEffect, useState } from "react";
import { api, type Group, type Message, type RoomPerson } from "@/state/store";
import { peerLine } from "./peer-message";

export interface MultiplayerMe {
  actorId: string | null;
  homeId: string;
}

let cached: Promise<MultiplayerMe | null> | null = null;

/** `/api/multiplayer/me`, fetched once per app session and shared. */
export function loadMultiplayerMe(): Promise<MultiplayerMe | null> {
  cached ??= api<MultiplayerMe>("/api/multiplayer/me").catch(() => {
    cached = null;
    return null;
  });
  return cached;
}

export function useMultiplayerMe(): MultiplayerMe | null {
  const [me, setMe] = useState<MultiplayerMe | null>(null);
  useEffect(() => {
    let alive = true;
    void loadMultiplayerMe().then((next) => { if (alive) setMe(next); });
    return () => { alive = false; };
  }, []);
  return me;
}

export interface RoomSender {
  mine: boolean;
  id?: string;
  name: string;
  person?: RoomPerson;
}

function ownerOf(homeId: string | undefined): string | undefined {
  return homeId ? `${homeId}:person:owner` : undefined;
}

/** The person behind a user line, or null for bot lines and peer deliveries. */
export function roomSender(
  message: Pick<Message, "role" | "text" | "peerAsk" | "sender">,
  group: Pick<Group, "people" | "home">,
  meId: string | null | undefined,
): RoomSender | null {
  if (message.role !== "user" || peerLine(message)) return null;
  const id = message.sender?.id ?? (group.home ? ownerOf(group.home.id) : undefined);
  const mine = id ? (meId ? id === meId : !group.home && id.endsWith(":person:owner")) : !group.home;
  const person = id ? group.people?.find((candidate) => candidate.id === id) : undefined;
  const name = person?.name ?? message.sender?.name ?? group.home?.name ?? "";
  return { mine, id, name, person };
}

/** The name a reply quote or pin banner shows; null means "you". */
export function roomSenderName(
  message: Pick<Message, "role" | "text" | "peerAsk" | "sender">,
  group: Pick<Group, "people" | "home">,
  meId: string | null | undefined,
): string | null {
  const sender = roomSender(message, group, meId);
  return sender && !sender.mine && sender.name ? sender.name : null;
}
