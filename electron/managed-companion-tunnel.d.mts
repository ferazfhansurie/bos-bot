// Types for managed-companion-tunnel.mjs as the headless server uses it
// (server/tunnel.ts). Keep in step with the implementation.
export declare const MANAGED_COMPANION_ENDPOINT_FIELD: string;
export declare const MANAGED_COMPANION_TOKEN_FIELD: string;
export declare const LEGACY_MANAGED_COMPANION_ENDPOINT_FIELD: string;
export declare const LEGACY_MANAGED_COMPANION_TOKEN_FIELD: string;
export declare const LEGACY_MANAGED_COMPANION_RETIRE_AT_FIELD: string;
export declare const LEGACY_MANAGED_COMPANION_GRACE_MS: number;

export interface ManagedTunnelAccess {
  endpoint: string;
  token: string;
  /** A retiring connector from a previous control plane, run beside this one. */
  legacy?: { endpoint: string; token: string } | null;
}

export interface ManagedTunnelState {
  status: string;
  ready: boolean;
  configured?: boolean;
  error?: string;
  retryInMs?: number;
}

export interface ManagedTunnelOriginTarget {
  pid: number;
  socketPath: string;
}

export interface ManagedTunnel {
  start(access: ManagedTunnelAccess & { originTarget: ManagedTunnelOriginTarget }): Promise<ManagedTunnelState>;
  stop(): Promise<ManagedTunnelState>;
  shutdown(): Promise<ManagedTunnelState>;
}

export type HostedCompanionStatus = "off" | "provisioning" | "ready" | "error";
export declare function hostedCompanionStatus(
  tunnelState: (ManagedTunnelState & { endpoint?: string }) | null | undefined,
  advertisedUrl?: string | null,
): HostedCompanionStatus;
export declare function companionKeepAwakeWanted(options?: {
  companionEnabled?: boolean;
  keepAwake?: boolean;
  hostedConfigured?: boolean;
  hostedStatus?: HostedCompanionStatus;
}): boolean;
export declare function normalizeManagedCompanionEndpoint(value: unknown): string;
export declare function managedCompanionTunnelAccess(credentials: Record<string, unknown>): ManagedTunnelAccess | null;
export declare function legacyManagedCompanionTunnelAccess(
  credentials: Record<string, unknown>,
  now?: number,
): { endpoint: string; token: string } | null;
export declare function hasExpiredLegacyManagedCompanionTunnel(credentials: Record<string, unknown>, now?: number): boolean;
export declare function withLegacyManagedCompanionTunnel<T extends Record<string, unknown>>(
  credentials: T,
  options?: { now?: number },
): T;
export declare function withoutLegacyManagedCompanionTunnel<T extends Record<string, unknown>>(credentials: T): T;
export declare function resolveCloudflaredBinary(options?: {
  isPackaged?: boolean;
  resourcesPath?: string;
  appPath?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  environment?: NodeJS.ProcessEnv;
  exists?: (candidate: string) => boolean;
}): string | null;
export declare function createManagedCompanionTunnel(options: {
  binaryPath: string | null;
  guardianEntry: string | null;
  runtimeExecutable?: string;
  originPort?: number;
  runtimeRoot: string;
  environment?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  verifyTimeoutMs?: number;
  verifyRequestTimeoutMs?: number;
  verifyIntervalMs?: number;
  stopGraceMs?: number;
  maxRetryMs?: number;
  onChange?: (state: ManagedTunnelState) => void;
  log?: (line: string) => void;
}): ManagedTunnel;

export function fetchWithPublicDnsFallback(
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: RequestRedirect },
  dependencies?: {
    fetchImpl?: typeof fetch;
    resolveAddress?: (hostname: string) => Promise<string>;
    request?: typeof import("node:https").request;
  },
): Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
