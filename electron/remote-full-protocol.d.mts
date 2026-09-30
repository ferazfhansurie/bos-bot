export interface RemoteFullOperation { botId: string; threadId: string; name: string; title: string; modelSelection: { instanceId: string; model: string; effort?: string; variant?: string }; revision: string; updateBotDefault: boolean; mode: "full" }
export interface RemoteFullChallenge { protocol: "bos.remote-full.v1"; nonce: string; environmentId: string; installationId: string; serverKey: string; audience: string; expiresAt: number; operations: RemoteFullOperation[] }
export const REMOTE_FULL_PROTOCOL: "bos.remote-full.v1";
export function canonical(value: unknown): string;
export function parseChallenge(value: unknown): RemoteFullChallenge;
