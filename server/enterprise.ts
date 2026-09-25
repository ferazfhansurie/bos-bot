import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestAuth } from "./request-auth.ts";
import type { SessionRegistry } from "./sessions.ts";

export interface EditionStatus { edition: "oss"; features: string[]; notice?: string }
export interface WorkspaceAccessOptions {
  sessions: SessionRegistry;
  cookieName: string;
  closeSessionStreams(sessionId: string): void;
  entitled(): boolean;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
}
export interface WorkspaceAccess {
  handlePublic(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  authorize(req: IncomingMessage, auth: RequestAuth): Promise<{ status: 401 | 403 | 503; error: string } | null>;
  revalidate(): Promise<void>;
}
export interface HostedWorkspaceConfiguration {
  admin: URL;
  tenant: URL;
  workspace: string;
  portalMembership: boolean;
}

const STATUS: EditionStatus = { edition: "oss", features: [] };
export function hostedWorkspaceConfigured(_env: NodeJS.ProcessEnv = process.env): boolean { return false }
export function hostedWorkspaceConfiguration(_env: NodeJS.ProcessEnv = process.env): HostedWorkspaceConfiguration | null { return null }
export function createWorkspaceAccess(_options: Omit<WorkspaceAccessOptions, "entitled">): WorkspaceAccess | null { return null }
export async function loadEnterpriseLayer(_options: { dir?: string; licenseKey?: string } = {}): Promise<EditionStatus> { return STATUS }
export function editionStatus(_now: number = Date.now()): EditionStatus { return STATUS }
export function entitled(_feature: string, _now: number = Date.now()): boolean { return false }
export function describeEdition(_status: EditionStatus = STATUS): string { return "bos bot personal edition" }
