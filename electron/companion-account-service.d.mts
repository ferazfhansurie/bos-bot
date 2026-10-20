// Types for companion-account-service.mjs as the headless server uses it
// (server/tunnel.ts). Keep in step with the implementation.
import type { ControlPlaneClient } from "./control-plane-client.mjs";

export declare const DEFAULT_COMPANION_CONTROL_PLANE_URL: string;
export declare const CONTROL_PLANE_URL_ENV: string;
export declare const LEGACY_CONTROL_PLANE_URL_ENV: string;
export declare function controlPlaneUnavailableReason(environment?: NodeJS.ProcessEnv): string;
export declare const COMPANION_CLIENT_INSTANCE_FIELD: string;
export declare const COMPANION_ACCOUNT_TOKEN_FIELD: string;
export declare const COMPANION_ACCOUNT_USER_ID_FIELD: string;
export declare const COMPANION_ACCOUNT_EMAIL_FIELD: string;
export declare const COMPANION_INSTALLATION_ID_FIELD: string;
export declare const COMPANION_INSTALLATION_CREDENTIAL_FIELD: string;
export declare const COMPANION_INSTALLATION_EXPIRY_FIELD: string;
export declare const COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD: string;
export declare const COMPANION_ACCOUNT_KIND_FIELD: string;
export declare const COMPANION_SILENT_OPT_OUT_FIELD: string;

export type CredentialDocument = Record<string, unknown>;

export declare function resolveCompanionControlPlaneURL(options?: {
  isPackaged?: boolean;
  environment?: NodeJS.ProcessEnv;
}): string;
export declare function companionAccountCleanupPending(credentials: CredentialDocument): boolean;
export declare function friendlyCompanionAccountError(error: unknown): string;

export interface CompanionAccountState {
  available: boolean;
  status: string;
  email?: string;
  endpoint?: string;
  message?: string;
}

export interface CompanionAccountService {
  state(): Promise<CompanionAccountState>;
  requestCode(email: string): Promise<CompanionAccountState>;
  verifyCode(email: string, code: string): Promise<CompanionAccountState>;
  retry(): Promise<CompanionAccountState>;
  signOut(): Promise<CompanionAccountState>;
  restore(): Promise<CompanionAccountState>;
}

export declare function createCompanionAccountService(options: {
  client: ControlPlaneClient | null;
  /** This control plane's origin. An account stored by another one reads as
   * signed out and is never sent here. "" accepts any stored account. */
  controlPlaneOrigin?: string;
  readCredentials: () => CredentialDocument;
  updateCredentials: (
    derive: (current: CredentialDocument) => CredentialDocument,
    afterPersist?: (next: CredentialDocument) => Promise<void> | void,
  ) => Promise<unknown>;
  identity: { name: string; platform: string; appVersion?: string };
  newClientInstanceId: () => string;
  activatePersistedEndpoint?: () => Promise<{ status: string; ready: boolean }>;
  stopManagedEndpoint?: () => Promise<void>;
  managedConnectionState?: () => { status: string; ready: boolean };
  companionIsOn?: () => boolean;
  now?: () => number;
  healthCacheMs?: number;
  healthFailureCacheMs?: number;
  /** Desktop only: register this computer with no email and move any older
   * hosted route aside. Headless `login` keeps the email flow. */
  silentRegistration?: boolean | (() => boolean);
  onAccountChanged?: () => void;
  sleep?: (milliseconds: number) => Promise<void>;
  setTimer?: (callback: () => void, milliseconds: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}): CompanionAccountService;
