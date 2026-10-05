/** Roles belong to the joined server, never to a person's home server. */
export type WorkspaceRole = "owner" | "admin" | "member" | "client-guest";
export interface WorkspaceMember { actorId: string; role: WorkspaceRole }
export interface RoomBotGrants { roomId: string; botIds: string[] }

export interface WorkspaceServer {
  homeId: string;
  name: string;
  home: boolean;
  available: boolean;
  actorId: string | null;
  role: WorkspaceRole;
}
export interface WorkspaceServersResponse { servers: WorkspaceServer[] }
export interface WorkspaceInviteInput {
  role?: Exclude<WorkspaceRole, "owner">;
  roomIds?: string[];
  /** An existing, owner-selected person identity; otherwise use the joining home. */
  personId?: string;
}
