export const RECEIPT_FILE: "enterprise-provision.json";
export const STATE_FILE: "enterprise-provision-state.json";
export const MAX_ARCHIVE_BYTES: number;

export interface EnterpriseProvision {
  version: 1;
  slug: string;
  label: string;
  url: string;
  token: string;
  password: string;
}

export interface EnterpriseReceipt {
  version: 1;
  slug: string;
  label: string;
  provisionedAt?: string;
  decidedAt?: string;
  skipped?: "not-fresh";
  restoreId?: string | null;
  archiveSha256?: string | null;
  appVersion?: string | null;
  applied?: { instances: string[]; mcpServers: string[]; features: string[]; bots: string[] } | null;
  done: boolean;
  doneAt?: string;
}

export class EnterpriseProvisionError extends Error { code: string; constructor(code: string, message: string); }

export const setupMessages: { running(label: string): string; failed: string };

export function readProvisionFile(resourcesPath: string, options?: { allowLoopbackForTests?: boolean }): EnterpriseProvision | null;
export function validateProvision(value: unknown, options?: { allowLoopbackForTests?: boolean }): EnterpriseProvision;
export function readReceipt(dataDir: string): EnterpriseReceipt | null;
export function provisioningDue(input: { provision: EnterpriseProvision | null; dataDir: string }): boolean;
export function downloadArchive(response: Response, file: string, options?: { maxBytes?: number; signal?: AbortSignal }): Promise<{ sha256: string; bytes: number }>;

type LocalInit = Omit<RequestInit, "body"> & { body?: unknown; duplex?: "half" };

export function runEnterpriseProvisioning(options: {
  provision: EnterpriseProvision;
  dataDir: string;
  localRequest: (route: string, init?: LocalInit) => Promise<Response>;
  restartServer: () => Promise<void>;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  tempRoot: string;
  appVersion?: string | null;
  log?: (line: string) => void;
  now?: () => Date;
  maxBytes?: number;
  archiveTimeoutMs?: number;
}): Promise<EnterpriseReceipt>;

export function confirmDone(options: {
  provision: EnterpriseProvision;
  dataDir: string;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  log?: (line: string) => void;
}): Promise<EnterpriseReceipt | null>;

export function setupPage(text: string): string;
