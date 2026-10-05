// What a paired phone may know about this computer's always-on connection.
//
// Electron owns the Cloudflare connector and the keep-awake setting; the
// sidecar only answers for them. The desktop pushes its view over the
// loopback control socket, and the phone reads it back through the proxy.
// Read-only on the phone side by construction: there is no device route
// that writes any of this.

export const HOSTED_STATUSES = ["off", "provisioning", "ready", "error"] as const;

export type HostedStatus = (typeof HOSTED_STATUSES)[number];

/** What the desktop reports. The hosted URL is not part of it: that travels
 * separately through `PUT /hosted-endpoint`, which Electron calls only after
 * the public health check passes. */
export interface ReportedCompanionStatus {
  hosted: HostedStatus;
  keepAwake: boolean;
}

/** The phone-facing `GET /api/companion/status` body. */
export interface CompanionStatus {
  hosted: { status: HostedStatus; url?: string };
  keepAwake: boolean;
}

export const DEFAULT_REPORTED_STATUS: ReportedCompanionStatus = Object.freeze({
  hosted: "off",
  keepAwake: false,
});

/** Combine the desktop's report with the advertised hosted URL.
 *
 * The advertised URL is the authority for "ready": it is the same value the
 * endpoint list uses, so the two answers can never disagree about whether a
 * phone may switch to the hosted route. A report of "ready" that has not yet
 * been matched by an advertised URL reads as still provisioning, and an
 * advertised URL always reads as ready. */
export function companionStatusSnapshot(
  hostedUrl: string | null,
  reported: ReportedCompanionStatus = DEFAULT_REPORTED_STATUS,
): CompanionStatus {
  if (hostedUrl) return { hosted: { status: "ready", url: hostedUrl }, keepAwake: reported.keepAwake };
  const status = reported.hosted === "ready" ? "provisioning" : reported.hosted;
  return { hosted: { status }, keepAwake: reported.keepAwake };
}

/** Exact shape of the control-socket write: `{hosted, keepAwake}` and nothing
 * else. Like the hosted-endpoint payload, extras are refused rather than
 * silently dropped, and the check stays dependency-free for the packaged
 * sidecar. */
export function isReportedCompanionStatus(value: unknown): value is ReportedCompanionStatus {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "hosted" || keys[1] !== "keepAwake") return false;
  const { hosted, keepAwake } = value as { hosted?: unknown; keepAwake?: unknown };
  return (
    typeof keepAwake === "boolean" &&
    typeof hosted === "string" &&
    (HOSTED_STATUSES as readonly string[]).includes(hosted)
  );
}
