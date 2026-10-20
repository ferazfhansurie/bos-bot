import { compatEnv, compatEnvironment } from "./branding-env.cjs";
import {
  ControlPlaneError,
  normalizeAccountEmail,
  normalizeControlPlaneURL,
} from "./control-plane-client.mjs";
import {
  LEGACY_MANAGED_COMPANION_GRACE_MS,
  LEGACY_MANAGED_COMPANION_RETIRE_AT_FIELD,
  MANAGED_COMPANION_ENDPOINT_FIELD,
  MANAGED_COMPANION_ORIGIN_VERSION_FIELD,
  MANAGED_COMPANION_TOKEN_FIELD,
  legacyManagedCompanionTunnelAccess,
  managedCompanionTunnelAccess,
  withLegacyManagedCompanionTunnel,
  withManagedCompanionTunnelAccess,
  withoutManagedCompanionTunnelAccess,
} from "./managed-companion-tunnel.mjs";

/** BOS Bot's own control plane: account sign-in, the hosted companion address
 * (c-<id>.bosbot.my), remote sign-in and `login --tunnel`. An operator can
 * point BOS_CONTROL_PLANE_URL (or legacy OMB_CONTROL_PLANE_URL) at their own,
 * or set it to "" to turn hosted access off. */
export const DEFAULT_COMPANION_CONTROL_PLANE_URL = "https://accounts.bosbot.my";
export const CONTROL_PLANE_URL_ENV = "BOS_CONTROL_PLANE_URL";
export const LEGACY_CONTROL_PLANE_URL_ENV = "OMB_CONTROL_PLANE_URL";

export const COMPANION_CLIENT_INSTANCE_FIELD = "companionClientInstanceId";
export const COMPANION_ACCOUNT_TOKEN_FIELD = "companionAccountToken";
export const COMPANION_ACCOUNT_USER_ID_FIELD = "companionAccountUserId";
export const COMPANION_ACCOUNT_EMAIL_FIELD = "companionAccountEmail";
export const COMPANION_INSTALLATION_ID_FIELD = "companionInstallationId";
export const COMPANION_INSTALLATION_CREDENTIAL_FIELD = "companionInstallationCredential";
export const COMPANION_INSTALLATION_EXPIRY_FIELD = "companionInstallationCredentialExpiresAt";
export const COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD = "companionAccountCleanupPending";
export const COMPANION_CONTROL_PLANE_ORIGIN_FIELD = "companionControlPlaneOrigin";
/** "installation" marks an account this computer registered for itself with
 * no email: its installation credential is the only proof it holds. */
export const COMPANION_ACCOUNT_KIND_FIELD = "companionAccountKind";
const INSTALLATION_ACCOUNT_KIND = "installation";
/** Set when the person signed out of secure access, so startup does not
 * quietly register again. Asking to connect a device clears it. */
export const COMPANION_SILENT_OPT_OUT_FIELD = "companionSilentRegistrationOff";
/** Accounts signed in before the origin was recorded came from the upstream
 * openmausbot service when their hosted address is one of its hosts. */
const UPSTREAM_CONTROL_PLANE = "upstream:openmausbot";
const UPSTREAM_HOSTED_SUFFIX = ".openmausbot.com";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTALLATION_ID = UUID;
const INSTALLATION_CREDENTIAL = /^omb_install_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const DEFAULT_HEALTH_CACHE_MS = 30_000;
/** A failed probe is remembered only briefly, so one slow answer at startup
 * does not leave the panel saying "needs attention" for the full cache. */
const DEFAULT_HEALTH_FAILURE_CACHE_MS = 5_000;
const STARTUP_PROBE_ATTEMPTS = 3;
const STARTUP_PROBE_PAUSE_MS = 2_000;
/** Quiet retries for silent registration after a failure. */
const SILENT_RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000];
const SILENT_RATE_LIMIT_DELAY_MS = 60 * 60_000;
/** An installation-owned computer checks in daily, so its credential is
 * renewed long before the server would revoke it as lapsed. */
const SILENT_MAINTENANCE_MS = 24 * 60 * 60_000;
/** Renew an installation-owned credential this long before it expires. */
const CREDENTIAL_RENEW_BEFORE_MS = 14 * 24 * 60 * 60_000;

const ownString = (document, field) =>
  typeof document?.[field] === "string" ? document[field] : "";

/** BOS_CONTROL_PLANE_URL wins over the legacy OMB_CONTROL_PLANE_URL; unset
 * means BOS Bot's own control plane. An explicit value must be an exact HTTPS
 * origin (or HTTP loopback Worker) so an OTP or bearer never goes to a host
 * the operator did not choose: empty or invalid disables the feature, with no
 * fallback to any other service. `isPackaged` is accepted for compatibility
 * and does not change the answer. */
export function resolveCompanionControlPlaneURL({
  environment = compatEnv,
} = {}) {
  const key = configuredControlPlaneKey(environment);
  return key
    ? normalizeControlPlaneURL(compatEnvironment(environment)[key])
    : DEFAULT_COMPANION_CONTROL_PLANE_URL;
}

/** The branding proxy (compatEnv) reports every BOS_* alias as an own key, so
 * "configured" means a value is actually present, not that the key exists. */
function configuredControlPlaneKey(environment) {
  return [CONTROL_PLANE_URL_ENV, LEGACY_CONTROL_PLANE_URL_ENV].find(
    (key) => environment && Object.hasOwn(environment, key) && environment[key] !== undefined,
  );
}

/** Why resolveCompanionControlPlaneURL returned "", phrased for operators. */
export function controlPlaneUnavailableReason(environment = compatEnv) {
  const configured = configuredControlPlaneKey(environment);
  if (configured && !String(compatEnvironment(environment)[configured] ?? "").trim()) {
    return `remote sign-in not configured: ${configured} is empty`;
  }
  return configured
    ? `${configured} is set but is not an https address`
    : `remote sign-in not configured: set ${CONTROL_PLANE_URL_ENV} to your control plane's https origin`;
}

/** Which control plane the stored account belongs to, "" when unknown. */
export function companionAccountControlPlane(credentials) {
  // A route on openmausbot's domain was issued by openmausbot, whatever origin
  // got recorded beside it; trusting the record would let a sign-in here
  // overwrite the route paired phones still use instead of retiring it.
  try {
    const hosted = new URL(ownString(credentials, MANAGED_COMPANION_ENDPOINT_FIELD));
    if (hosted.hostname.endsWith(UPSTREAM_HOSTED_SUFFIX)) return UPSTREAM_CONTROL_PLANE;
  } catch {}
  return ownString(credentials, COMPANION_CONTROL_PLANE_ORIGIN_FIELD);
}

/** Field presence only, for the startup log: never values. */
export function companionAccountSummary(credentials, controlPlaneOrigin) {
  const owner = companionAccountControlPlane(credentials);
  let primaryHost = "none";
  try {
    const hosted = new URL(ownString(credentials, MANAGED_COMPANION_ENDPOINT_FIELD));
    primaryHost = hosted.hostname.endsWith(UPSTREAM_HOSTED_SUFFIX) ? "openmausbot" : hosted.hostname.split(".").slice(-2).join(".");
  } catch {}
  return [
    `owner=${!owner ? "unmarked" : owner === controlPlaneOrigin ? "this" : owner === UPSTREAM_CONTROL_PLANE ? "openmausbot" : "other"}`,
    `account=${Boolean(storedAccountFields(credentials))}`,
    `primary=${primaryHost}`,
    `primaryUsable=${Boolean(managedCompanionTunnelAccess(credentials))}`,
    `legacy=${Boolean(legacyManagedCompanionTunnelAccess(credentials))}`,
    `cleanupPending=${companionAccountCleanupPending(credentials)}`,
  ].join(" ");
}

/** An account from another control plane is never sent to this one: its
 * bearer would be rejected, and cleanup would wipe the connector that paired
 * phones still use. Unknown (pre-origin) accounts are assumed to be local. */
function accountBelongsTo(credentials, controlPlaneOrigin) {
  if (!controlPlaneOrigin) return true;
  const owner = companionAccountControlPlane(credentials);
  return !owner || owner === controlPlaneOrigin;
}

function withoutAccountFields(credentials) {
  const next = { ...credentials };
  for (const field of [
    COMPANION_ACCOUNT_TOKEN_FIELD,
    COMPANION_ACCOUNT_USER_ID_FIELD,
    COMPANION_ACCOUNT_EMAIL_FIELD,
    COMPANION_INSTALLATION_ID_FIELD,
    COMPANION_INSTALLATION_CREDENTIAL_FIELD,
    COMPANION_INSTALLATION_EXPIRY_FIELD,
    COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD,
    COMPANION_CONTROL_PLANE_ORIGIN_FIELD,
    COMPANION_ACCOUNT_KIND_FIELD,
  ]) {
    delete next[field];
  }
  return next;
}

/** This computer registered itself here: retire another control plane's
 * route exactly as an email sign-in would, then record the new account. */
function withInstallationOwnedAccount(credentials, { registered, controlPlaneOrigin }) {
  const next = withoutAccountFields(withAccountMovedToControlPlane(credentials, controlPlaneOrigin));
  next[COMPANION_ACCOUNT_KIND_FIELD] = INSTALLATION_ACCOUNT_KIND;
  next[COMPANION_INSTALLATION_ID_FIELD] = registered.installation.id;
  next[COMPANION_INSTALLATION_CREDENTIAL_FIELD] = registered.credential;
  if (Number.isSafeInteger(registered.credentialExpiresAt)) {
    next[COMPANION_INSTALLATION_EXPIRY_FIELD] = registered.credentialExpiresAt;
  }
  if (controlPlaneOrigin) next[COMPANION_CONTROL_PLANE_ORIGIN_FIELD] = controlPlaneOrigin;
  delete next[COMPANION_SILENT_OPT_OUT_FIELD];
  return next;
}

/** Signing in to a new control plane: forget the other one's account locally
 * (no remote calls, they belong to that service) and keep its connector as the
 * retiring route so phones paired through it can move without a re-scan. */
export function withAccountMovedToControlPlane(credentials, controlPlaneOrigin, options) {
  if (accountBelongsTo(credentials, controlPlaneOrigin)) return credentials;
  // A sign-out still in progress there already took that route down; it
  // must not come back as the retiring one.
  const routes = companionAccountCleanupPending(credentials)
    ? withoutManagedCompanionTunnelAccess(credentials)
    : withLegacyManagedCompanionTunnel(credentials, options);
  return withoutAccountFields(routes);
}

export function companionAccountCleanupPending(credentials) {
  return credentials?.[COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD] === true;
}

function storedAccountFields(credentials) {
  if (credentials?.[COMPANION_ACCOUNT_KIND_FIELD] === INSTALLATION_ACCOUNT_KIND) {
    const installationId = ownString(credentials, COMPANION_INSTALLATION_ID_FIELD);
    if (!INSTALLATION_ID.test(installationId)) return null;
    const credential = ownString(credentials, COMPANION_INSTALLATION_CREDENTIAL_FIELD);
    return {
      kind: INSTALLATION_ACCOUNT_KIND,
      email: "",
      userId: "",
      accountToken: "",
      installationId,
      installationCredential: INSTALLATION_CREDENTIAL.test(credential) ? credential : "",
    };
  }
  const email = normalizeAccountEmail(ownString(credentials, COMPANION_ACCOUNT_EMAIL_FIELD));
  const userId = ownString(credentials, COMPANION_ACCOUNT_USER_ID_FIELD);
  if (!email || !userId || userId.length > 256) return null;
  return {
    kind: "email",
    email,
    userId,
    accountToken: ownString(credentials, COMPANION_ACCOUNT_TOKEN_FIELD),
    installationId: INSTALLATION_ID.test(ownString(credentials, COMPANION_INSTALLATION_ID_FIELD))
      ? credentials[COMPANION_INSTALLATION_ID_FIELD]
      : "",
    installationCredential: INSTALLATION_CREDENTIAL.test(
      ownString(credentials, COMPANION_INSTALLATION_CREDENTIAL_FIELD),
    )
      ? credentials[COMPANION_INSTALLATION_CREDENTIAL_FIELD]
      : "",
  };
}

/** Drops only the primary hosted route; a retiring route from an earlier
 * move keeps serving phones paired through it. */
function withoutManagedCompanionTunnelAccessKeepingLegacy(credentials) {
  const next = { ...credentials };
  delete next[MANAGED_COMPANION_ENDPOINT_FIELD];
  delete next[MANAGED_COMPANION_TOKEN_FIELD];
  delete next[MANAGED_COMPANION_ORIGIN_VERSION_FIELD];
  return next;
}

function withoutCompanionAccount(credentials) {
  const next = withoutAccountFields(withoutManagedCompanionTunnelAccess(credentials));
  // The UUID identifies this installation, not an account. Keeping it across
  // sign-outs lets a same-account recovery adopt the existing server record
  // rather than manufacturing a new computer every time.
  return next;
}

function withProvisionedAccount(credentials, { accountToken, user, installation, provision, controlPlaneOrigin = "" }) {
  const withEndpoint = withManagedCompanionTunnelAccess(credentials, provision);
  const next = {
    ...withEndpoint,
    // Accounts from before the origin was recorded get it on their next
    // provision, so a later change of control plane can recognise them.
    ...(controlPlaneOrigin && !ownString(credentials, COMPANION_CONTROL_PLANE_ORIGIN_FIELD)
      ? { [COMPANION_CONTROL_PLANE_ORIGIN_FIELD]: controlPlaneOrigin }
      : {}),
    [COMPANION_ACCOUNT_TOKEN_FIELD]: accountToken,
    [COMPANION_ACCOUNT_USER_ID_FIELD]: user.id,
    [COMPANION_ACCOUNT_EMAIL_FIELD]: user.email,
    [COMPANION_INSTALLATION_ID_FIELD]: installation.installation.id,
    [COMPANION_INSTALLATION_CREDENTIAL_FIELD]: installation.credential,
  };
  if (Number.isSafeInteger(installation.credentialExpiresAt)) {
    next[COMPANION_INSTALLATION_EXPIRY_FIELD] = installation.credentialExpiresAt;
  } else {
    delete next[COMPANION_INSTALLATION_EXPIRY_FIELD];
  }
  delete next[COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD];
  delete next[COMPANION_ACCOUNT_KIND_FIELD];
  return next;
}

function withAuthenticatedAccount(
  credentials,
  { accountToken, user, clientInstanceId, preserveCleanupPending = false, controlPlaneOrigin = "" },
) {
  const next = {
    ...withAccountMovedToControlPlane(credentials, controlPlaneOrigin),
    [COMPANION_ACCOUNT_TOKEN_FIELD]: accountToken,
    [COMPANION_ACCOUNT_USER_ID_FIELD]: user.id,
    [COMPANION_ACCOUNT_EMAIL_FIELD]: user.email,
  };
  if (controlPlaneOrigin) next[COMPANION_CONTROL_PLANE_ORIGIN_FIELD] = controlPlaneOrigin;
  delete next[COMPANION_ACCOUNT_KIND_FIELD];
  delete next[COMPANION_SILENT_OPT_OUT_FIELD];
  if (!UUID.test(ownString(next, COMPANION_CLIENT_INSTANCE_FIELD))) {
    next[COMPANION_CLIENT_INSTANCE_FIELD] = clientInstanceId;
  }
  if (preserveCleanupPending) {
    next[COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD] = true;
  } else {
    delete next[COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD];
  }
  return next;
}

const FRIENDLY_MESSAGES = Object.freeze({
  invalid_email: "Enter a valid email address.",
  invalid_request: "The secure connection request was not accepted. Check the details and try again.",
  invalid_otp: "That code is not valid. Check the email and try again.",
  otp_expired: "That code expired. Email yourself a new one.",
  unauthorized: "Your sign-in expired. Email yourself a new code to reconnect.",
  forbidden: "The secure connection request was not allowed. Try signing in again.",
  signed_out: "Your sign-in expired. Email yourself a new code to reconnect.",
  network_unavailable: "BOS Bot could not reach its secure connection service. Check your internet and try again.",
  rate_limited: "Too many attempts were made. Wait a little, then try again.",
  credential_rotation_rate_limited: "This computer was reconnected too often. Wait a little, then try again.",
  installation_limit_reached: "This account has reached its computer limit. Remove an old computer and try again.",
  installation_exists: "This computer is already connected. Try again to recover it.",
  endpoint_busy: "The secure connection is still being prepared. Try again in a moment.",
  endpoint_unavailable: "The secure connection service could not finish setup. Local pairing still works; try again shortly.",
  endpoint_cleanup_pending: "The secure connection is still being removed. Try signing out again shortly.",
  control_plane_unavailable: "Secure access is not available right now. Local pairing still works.",
  internal_error: "The secure connection service had a problem. Local pairing still works; try again.",
  invalid_response: "The secure connection service returned an unexpected response. Try again.",
  request_failed: "The secure connection request could not be completed. Local pairing still works; try again.",
  registration_closed: "Secure access is full right now. Local pairing still works; BOS Bot will try again later.",
});

export function friendlyCompanionAccountError(error) {
  const code = error instanceof ControlPlaneError ? error.code : "";
  const message = FRIENDLY_MESSAGES[code] ?? FRIENDLY_MESSAGES.request_failed;
  const reference = error instanceof ControlPlaneError && error.requestId
    ? ` Reference: ${error.requestId}.`
    : "";
  return `${message}${reference}`;
}

function publicState({ available, status, email, endpoint, message, moveRequired = false }) {
  const state = { available: Boolean(available), status };
  if (moveRequired) state.moveRequired = true;
  const normalizedEmail = normalizeAccountEmail(email);
  if (normalizedEmail) state.email = normalizedEmail;
  const accessEndpoint = (() => {
    if (typeof endpoint !== "string") return "";
    try {
      const parsed = new URL(endpoint);
      return parsed.protocol === "https:" && parsed.pathname === "/" && !parsed.search && !parsed.hash
        ? parsed.origin
        : "";
    } catch {
      return "";
    }
  })();
  if (accessEndpoint) state.endpoint = accessEndpoint;
  const safeMessage = typeof message === "string" && message.length >= 1 && message.length <= 280
    ? message
    : null;
  if (safeMessage) state.message = safeMessage;
  return Object.freeze(state);
}

/** Authenticated hosted-Companion orchestration, with all Electron, storage,
 * and network mechanisms injected. Nothing returned by this service can
 * contain an account bearer, installation credential, connector token, or a
 * Cloudflare resource identifier. */
export function createCompanionAccountService({
  client,
  controlPlaneOrigin = "",
  readCredentials,
  updateCredentials,
  identity,
  newClientInstanceId,
  activatePersistedEndpoint = async () => ({ status: "stopped", ready: false }),
  stopManagedEndpoint = async () => {},
  managedConnectionState = () => ({ status: "stopped", ready: false }),
  companionIsOn = () => false,
  now = Date.now,
  healthCacheMs = DEFAULT_HEALTH_CACHE_MS,
  healthFailureCacheMs = DEFAULT_HEALTH_FAILURE_CACHE_MS,
  // The desktop gets its hosted address with no email. Headless `login`
  // keeps the explicit email flow, so this is off unless the app asks. A
  // function is read each time (the app knows only after its store loads).
  silentRegistration = false,
  onAccountChanged = () => {},
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  setTimer = (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimer = (timer) => clearTimeout(timer),
} = {}) {
  const configured = Boolean(client);
  let healthy = false;
  let lastHealthCheck = null;
  let healthProbe = null;
  let phase = null;
  let transition = Promise.resolve();
  let silentFailures = 0;
  let silentTimer = null;
  let silentQueued = false;

  const serialize = (work) => {
    const next = transition.then(work, work);
    transition = next.then(
      () => {},
      () => {},
    );
    return next;
  };

  const silentOn = () =>
    Boolean(typeof silentRegistration === "function" ? silentRegistration() : silentRegistration);
  const credentials = () => readCredentials?.() ?? {};
  // Phones paired through another control plane (or its retiring route) keep
  // working, but this computer has no address of its own until someone signs
  // in here. The panel must ask for that instead of offering the old route.
  const needsMove = (document) =>
    Boolean(controlPlaneOrigin) &&
    !companionAccountCleanupPending(document) &&
    (!accountBelongsTo(document, controlPlaneOrigin) ||
      Boolean(legacyManagedCompanionTunnelAccess(document)));
  const storedAccount = (document) =>
    accountBelongsTo(document, controlPlaneOrigin) ? storedAccountFields(document) : null;

  const probeControlPlane = async ({ force = false } = {}) => {
    if (!configured) return false;
    const checkedAt = now();
    if (
      !force &&
      lastHealthCheck !== null &&
      checkedAt - lastHealthCheck < Math.max(0, healthy ? healthCacheMs : Math.min(healthCacheMs, healthFailureCacheMs))
    ) {
      return healthy;
    }
    if (healthProbe) return healthProbe;
    healthProbe = (async () => {
      try {
        await client.health();
        healthy = true;
      } catch {
        healthy = false;
      }
      lastHealthCheck = now();
      return healthy;
    })().finally(() => {
      healthProbe = null;
    });
    return healthProbe;
  };

  /** Startup: one slow answer must not decide the session. */
  const probeWithRetries = async () => {
    for (let attempt = 1; attempt <= STARTUP_PROBE_ATTEMPTS; attempt += 1) {
      if (await probeControlPlane({ force: true })) return true;
      if (attempt < STARTUP_PROBE_ATTEMPTS) await sleep(STARTUP_PROBE_PAUSE_MS);
    }
    return false;
  };

  const requireHealthyControlPlane = async () => {
    if (!(await probeControlPlane({ force: true }))) {
      throw new ControlPlaneError("control_plane_unavailable");
    }
  };

  const settledState = () => {
    if (!configured) {
      return publicState({
        available: false,
        status: "signed-out",
        message: FRIENDLY_MESSAGES.control_plane_unavailable,
      });
    }
    const document = credentials();
    const account = storedAccount(document);
    const persistedAccess = managedCompanionTunnelAccess(document);
    const available = healthy || Boolean(account);
    if (!healthy) {
      return publicState({
        available,
        status: account ? "error" : "signed-out",
        email: account?.email,
        endpoint: persistedAccess?.endpoint,
        message: FRIENDLY_MESSAGES.control_plane_unavailable,
      });
    }
    if (
      phase &&
      ["connecting", "error"].includes(phase.status) &&
      account &&
      persistedAccess &&
      !companionAccountCleanupPending(document) &&
      managedConnectionState?.()?.ready === true
    ) {
      phase = null;
    }
    if (phase) return publicState({ available, ...phase });
    if (!account) {
      return publicState({ available, status: "signed-out", moveRequired: needsMove(document) });
    }
    const access = persistedAccess;
    if (!access) {
      return publicState({
        available,
        status: "error",
        email: account.email,
        message: "This computer still needs a secure address. Try again; local pairing continues to work.",
      });
    }
    const connection = managedConnectionState?.() ?? {};
    if (companionIsOn()) {
      if (["starting", "retrying"].includes(connection.status)) {
        return publicState({
          available,
          status: "connecting",
          email: account.email,
          endpoint: access.endpoint,
          message: "The secure connection is starting. Local pairing remains available.",
        });
      }
      if (["unavailable", "error"].includes(connection.status)) {
        return publicState({
          available,
          status: "error",
          email: account.email,
          endpoint: access.endpoint,
          message: "The secure connection needs attention. Local pairing still works.",
        });
      }
    }
    return publicState({
      available,
      status: "ready",
      email: account.email,
      endpoint: access.endpoint,
    });
  };

  const ensureClientIdentity = async () => {
    const existing = ownString(credentials(), COMPANION_CLIENT_INSTANCE_FIELD);
    if (UUID.test(existing)) return existing;
    const candidate = newClientInstanceId?.();
    if (!UUID.test(candidate ?? "")) throw new Error("A stable computer identity could not be created");
    await updateCredentials((document) => {
      if (UUID.test(ownString(document, COMPANION_CLIENT_INSTANCE_FIELD))) return document;
      return { ...document, [COMPANION_CLIENT_INSTANCE_FIELD]: candidate };
    });
    return ownString(credentials(), COMPANION_CLIENT_INSTANCE_FIELD);
  };

  const markCleanupPending = async () => {
    await updateCredentials((document) => ({
      ...document,
      [COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD]: true,
    }));
  };

  const clearAfterCleanup = async () => {
    await updateCredentials(withoutCompanionAccount);
    await stopManagedEndpoint();
    phase = null;
  };

  /** Returns true only when the installation was revoked (which schedules
   * endpoint cleanup) and it is safe to forget its local retry credentials. */
  const cleanupCurrentAccount = async ({ markPending = true } = {}) => {
    const document = credentials();
    const account = storedAccount(document);
    if (!account) {
      await clearAfterCleanup();
      return true;
    }
    if (markPending && !companionAccountCleanupPending(document)) await markCleanupPending();
    await stopManagedEndpoint();

    if (account.kind === INSTALLATION_ACCOUNT_KIND) {
      // No account bearer: the credential deletes the endpoint and revokes
      // its own installation, which also schedules the server-side sweep.
      if (account.installationCredential) {
        await client.deleteEndpoint(account.installationCredential).catch(() => {});
        try {
          await client.revokeSelf(account.installationCredential);
        } catch (error) {
          // 401: already revoked or expired, so nothing is left to remove.
          if (!(error instanceof ControlPlaneError) || error.status !== 401) throw error;
        }
      }
      await clearAfterCleanup();
      return true;
    }

    // Deleting first gives immediate feedback. Revocation remains mandatory:
    // it invalidates the installation credential and gives the server a
    // durable cleanup path even if the direct delete failed halfway through.
    if (account.installationCredential) {
      try {
        await client.deleteEndpoint(account.installationCredential);
      } catch {
        // Revocation below is the authoritative cleanup schedule.
      }
    }
    if (!account.accountToken) {
      throw new ControlPlaneError("signed_out", 401);
    }

    // A request can create an installation (and even its endpoint) while its
    // response is lost, leaving no local ID or connector material. The stable
    // computer UUID is therefore the cleanup authority: list the account's
    // active installations and revoke every matching record before forgetting
    // the bearer. Revocation marks the owner row and durably schedules the
    // server-side endpoint sweep.
    const clientInstanceId = ownString(document, COMPANION_CLIENT_INSTANCE_FIELD);
    if (!UUID.test(clientInstanceId)) {
      throw new ControlPlaneError("invalid_client_identity");
    }

    // The known ID is a fast path. Its result is not trusted on its own: the
    // authoritative list below also catches a response-lost duplicate.
    if (account.installationId) {
      await client.revokeInstallation(account.accountToken, account.installationId).catch(() => {});
    }
    const installations = await client.listInstallations(account.accountToken);
    for (const installation of installations) {
      if (
        installation.clientInstanceId !== clientInstanceId &&
        installation.id !== account.installationId
      ) {
        continue;
      }
      try {
        await client.revokeInstallation(account.accountToken, installation.id);
      } catch (error) {
        if (!(error instanceof ControlPlaneError) || error.status !== 404) throw error;
      }
    }
    try {
      await client.signOut(account.accountToken);
    } catch {
      // The installation and connector have already been revoked. A stale
      // Better Auth session expires server-side and must not block local
      // sign-out or retain its bearer on disk.
    }
    await clearAfterCleanup();
    return true;
  };

  const provision = async ({ accountToken, user }) => {
    const clientInstanceId = await ensureClientIdentity();
    const before = credentials();
    const previous = storedAccount(before);
    const installation = await client.ensureInstallation({
      accountToken,
      currentCredential:
        previous?.userId === user.id ? previous.installationCredential : "",
      clientInstanceId,
      name: identity.name,
      platform: identity.platform,
      appVersion: identity.appVersion,
    });
    const endpoint = await client.ensureEndpoint(installation.credential);
    try {
      await updateCredentials((document) =>
        withProvisionedAccount(document, {
          accountToken,
          user,
          installation,
          provision: endpoint,
          controlPlaneOrigin,
        }),
      );
    } catch (error) {
      // Persistence failed after remote allocation. Best effort cleanup avoids
      // an invisible tunnel; no secret is ever written to a log or exception.
      await client.deleteEndpoint(installation.credential).catch(() => {});
      await client.revokeInstallation(accountToken, installation.installation.id).catch(() => {});
      throw error;
    }
    const connection = await activatePersistedEndpoint();
    phase = null;
    if (
      companionIsOn() &&
      connection &&
      ["unavailable", "error"].includes(connection.status)
    ) {
      phase = {
        status: "error",
        email: user.email,
        endpoint: endpoint.endpoint.url,
        message: "The address is ready, but this app could not start its secure connection. Local pairing still works.",
      };
    }
    return settledState();
  };

  const silentEnabled = () =>
    configured && silentOn() && credentials()?.[COMPANION_SILENT_OPT_OUT_FIELD] !== true;

  const cancelSilentRetry = () => {
    if (silentTimer !== null) clearTimer(silentTimer);
    silentTimer = null;
  };

  /** Quiet backoff: the current route and local pairing keep working, and
   * nothing asks the person to do anything. */
  const scheduleSilentRetry = (error) => {
    if (!silentOn()) return;
    cancelSilentRetry();
    let delay = SILENT_RETRY_DELAYS_MS[Math.min(silentFailures, SILENT_RETRY_DELAYS_MS.length - 1)];
    silentFailures += 1;
    if (
      error instanceof ControlPlaneError &&
      (error.status === 429 || error.code === "registration_closed")
    ) {
      delay = Math.max(delay, SILENT_RATE_LIMIT_DELAY_MS);
    }
    silentTimer = setTimer(() => {
      silentTimer = null;
      void serialize(silentWork).catch(() => {});
    }, delay);
    silentTimer?.unref?.();
  };

  const scheduleMaintenance = () => {
    cancelSilentRetry();
    silentTimer = setTimer(() => {
      silentTimer = null;
      void serialize(silentWork).catch(() => {});
    }, SILENT_MAINTENANCE_MS);
    silentTimer?.unref?.();
  };

  /** After a successful silent step: an installation-owned account keeps a
   * daily check-in, anything else needs no timer. */
  const silentSucceeded = () => {
    silentFailures = 0;
    if (storedAccount(credentials())?.kind === INSTALLATION_ACCOUNT_KIND) scheduleMaintenance();
    else cancelSilentRetry();
  };

  /** Persist the hosted route for an installation-owned account and start it. */
  const activateInstallationEndpoint = async (installationCredential) => {
    const endpoint = await client.ensureEndpoint(installationCredential);
    await updateCredentials((document) => {
      // Signed out (or replaced) while the request was in flight.
      if (ownString(document, COMPANION_INSTALLATION_CREDENTIAL_FIELD) !== installationCredential) {
        throw new ControlPlaneError("signed_out", 401);
      }
      const next = withManagedCompanionTunnelAccess(document, endpoint);
      // The retiring route's grace starts when its replacement exists, not
      // when the move began: a registration that took days to complete must
      // not leave paired phones with no route at all.
      if (!managedCompanionTunnelAccess(document) && legacyManagedCompanionTunnelAccess(document)) {
        next[LEGACY_MANAGED_COMPANION_RETIRE_AT_FIELD] = Math.max(
          document[LEGACY_MANAGED_COMPANION_RETIRE_AT_FIELD],
          now() + LEGACY_MANAGED_COMPANION_GRACE_MS,
        );
      }
      return next;
    });
    const connection = await activatePersistedEndpoint();
    phase = null;
    if (companionIsOn() && connection && ["unavailable", "error"].includes(connection.status)) {
      phase = {
        status: "error",
        endpoint: endpoint.endpoint.url,
        message: "The address is ready, but this app could not start its secure connection. Local pairing still works.",
      };
    }
  };

  const registerThisComputer = async () => {
    const clientInstanceId = await ensureClientIdentity();
    const registered = await client.registerInstallation({
      clientInstanceId,
      name: identity.name,
      platform: identity.platform,
      appVersion: identity.appVersion,
    });
    try {
      await updateCredentials((document) =>
        withInstallationOwnedAccount(document, { registered, controlPlaneOrigin }),
      );
    } catch (error) {
      // Never leave an installation nobody holds the credential for.
      await client.revokeSelf(registered.credential).catch(() => {});
      throw error;
    }
    onAccountChanged();
    await activateInstallationEndpoint(registered.credential);
    onAccountChanged();
  };

  /** Keeps an installation-owned account usable: re-registers when its
   * credential is gone or rejected, renews it before expiry, and fetches the
   * hosted route when none is stored. */
  const maintainInstallationAccount = async (account, { refreshEndpoint = true } = {}) => {
    let credential = account.installationCredential;
    let expiresAt = credentials()?.[COMPANION_INSTALLATION_EXPIRY_FIELD];
    if (credential) {
      try {
        const self = await client.inspectSelf(credential);
        if (Number.isSafeInteger(self.credentialExpiresAt)) expiresAt = self.credentialExpiresAt;
      } catch (error) {
        if (!(error instanceof ControlPlaneError) || error.status !== 401) throw error;
        credential = "";
      }
    }
    if (!credential) {
      // The server forgot this computer (revoked or expired). Its old record
      // and endpoint are already swept; start a fresh one.
      await stopManagedEndpoint();
      await updateCredentials((document) => withoutAccountFields(withoutManagedCompanionTunnelAccessKeepingLegacy(document)));
      await registerThisComputer();
      return;
    }
    if (Number.isSafeInteger(expiresAt) && expiresAt - now() < CREDENTIAL_RENEW_BEFORE_MS) {
      const rotated = await client.rotateSelfCredential(credential);
      await updateCredentials((document) => ({
        ...document,
        [COMPANION_INSTALLATION_CREDENTIAL_FIELD]: rotated.credential,
        ...(Number.isSafeInteger(rotated.credentialExpiresAt)
          ? { [COMPANION_INSTALLATION_EXPIRY_FIELD]: rotated.credentialExpiresAt }
          : {}),
      }));
      credential = rotated.credential;
    }
    if (refreshEndpoint || !managedCompanionTunnelAccess(credentials())) {
      await activateInstallationEndpoint(credential);
    } else {
      phase = null;
    }
  };

  /** Startup, a retry, or the connect screen with no account here: register
   * this computer quietly and move any older route aside. */
  const silentWork = async ({ probed = false } = {}) => {
    const document = credentials();
    const account = storedAccount(document);
    if (
      !configured ||
      (account && account.kind !== INSTALLATION_ACCOUNT_KIND) ||
      (account && companionAccountCleanupPending(document)) ||
      (!account && !silentEnabled())
    ) {
      // Never leave a "connecting" placeholder from state() behind.
      if (phase?.status === "connecting") phase = null;
      return settledState();
    }
    phase = { status: "connecting" };
    try {
      if (!probed) await requireHealthyControlPlane();
      if (account) await maintainInstallationAccount(account, { refreshEndpoint: false });
      else await registerThisComputer();
      silentSucceeded();
    } catch (error) {
      failAction(error);
      scheduleSilentRetry(error);
    }
    return settledState();
  };

  const failAction = (
    error,
    { email, expiredSessionIsSignedOut = false, signedOut = false } = {},
  ) => {
    const message = friendlyCompanionAccountError(error);
    phase = {
      status:
        signedOut ||
        (expiredSessionIsSignedOut && error instanceof ControlPlaneError && error.status === 401)
          ? "signed-out"
          : "error",
      email,
      message,
    };
    return message;
  };

  const requestCode = (rawEmail) => serialize(async () => {
    if (!configured) throw new Error(FRIENDLY_MESSAGES.control_plane_unavailable);
    const email = normalizeAccountEmail(rawEmail);
    let requested;
    try {
      await requireHealthyControlPlane();
      requested = await client.requestOTP(email);
    } catch (error) {
      const message = failAction(error, { email, signedOut: true });
      throw new Error(message);
    }
    phase = {
      status: "signed-out",
      email: requested.email,
    };
    return settledState();
  });

  const verifyCode = (rawEmail, rawCode) => serialize(async () => {
    if (!configured) throw new Error(FRIENDLY_MESSAGES.control_plane_unavailable);
    const email = normalizeAccountEmail(rawEmail);
    phase = { status: "connecting", email };
    let verified;
    try {
      await requireHealthyControlPlane();
      verified = await client.verifyOTP(email, rawCode);
    } catch (error) {
      const message = failAction(error, { email, signedOut: true });
      throw new Error(message);
    }

    const previous = storedAccount(credentials());
    const refreshingPendingCleanup = Boolean(
      previous &&
      previous.userId === verified.user.id &&
      companionAccountCleanupPending(credentials()),
    );
    let authenticatedPersisted = false;
    try {
      if (previous && previous.userId !== verified.user.id) {
        await cleanupCurrentAccount();
      }
      const existingIdentity = ownString(credentials(), COMPANION_CLIENT_INSTANCE_FIELD);
      const clientInstanceId = UUID.test(existingIdentity)
        ? existingIdentity
        : newClientInstanceId?.();
      if (!UUID.test(clientInstanceId ?? "")) {
        throw new Error("A stable computer identity could not be created");
      }
      await updateCredentials((document) =>
        withAuthenticatedAccount(document, {
          ...verified,
          clientInstanceId,
          preserveCleanupPending: refreshingPendingCleanup,
          controlPlaneOrigin,
        }),
      );
      authenticatedPersisted = true;
      if (refreshingPendingCleanup) {
        // The user supplied a fresh bearer to finish an interrupted sign-out.
        // Keep that intent and retry revocation; do not silently turn the
        // sign-out action into a new endpoint provisioning operation.
        await cleanupCurrentAccount({ markPending: false });
        return settledState();
      }
      return await provision(verified);
    } catch (error) {
      if (!authenticatedPersisted) await client.signOut(verified.accountToken).catch(() => {});
      failAction(error, {
        email: authenticatedPersisted ? verified.user.email : previous?.email ?? email,
        expiredSessionIsSignedOut: authenticatedPersisted,
      });
      return settledState();
    }
  });

  /** An email sign-in's session expired. The app no longer offers the email
   * flow, so in silent mode that account can never be renewed: forget it
   * here (its route keeps serving paired phones as the retiring one, or is
   * deleted when the person was signing out) and register this computer. */
  const replaceExpiredEmailAccount = async (account, { signingOut }) => {
    if (signingOut) {
      await stopManagedEndpoint();
      if (account.installationCredential) {
        await client.deleteEndpoint(account.installationCredential).catch(() => {});
      }
    }
    await updateCredentials((document) =>
      withoutAccountFields(
        signingOut
          ? withoutManagedCompanionTunnelAccessKeepingLegacy(document)
          : withLegacyManagedCompanionTunnel(document, { now: now() }),
      ),
    );
    phase = null;
    onAccountChanged();
    if (!silentEnabled()) return settledState();
    return silentWork({ probed: true });
  };

  const expiredEmailSession = (account, error) =>
    silentOn() &&
    account.kind !== INSTALLATION_ACCOUNT_KIND &&
    error instanceof ControlPlaneError &&
    error.status === 401;

  const retryWork = async () => {
    if (!configured) return settledState();
    const account = storedAccount(credentials());
    if (!account) {
      if (silentOn()) {
        // An explicit retry is consent again after a sign-out.
        if (credentials()?.[COMPANION_SILENT_OPT_OUT_FIELD] === true) {
          await updateCredentials((document) => {
            const next = { ...document };
            delete next[COMPANION_SILENT_OPT_OUT_FIELD];
            return next;
          });
        }
        silentFailures = 0;
        cancelSilentRetry();
        return silentWork();
      }
      // "Try again" must actually ask the control plane again rather than
      // replaying a cached failure.
      phase = null;
      await probeControlPlane({ force: true });
      return settledState();
    }
    if (companionAccountCleanupPending(credentials())) {
      phase = { status: "connecting", email: account.email };
      try {
        await requireHealthyControlPlane();
        await cleanupCurrentAccount({ markPending: false });
      } catch (error) {
        if (expiredEmailSession(account, error)) return replaceExpiredEmailAccount(account, { signingOut: true });
        failAction(error, { email: account.email, expiredSessionIsSignedOut: true });
      }
      return settledState();
    }
    if (account.kind === INSTALLATION_ACCOUNT_KIND) {
      silentFailures = 0;
      cancelSilentRetry();
      phase = { status: "connecting" };
      try {
        await requireHealthyControlPlane();
        await maintainInstallationAccount(account);
        silentSucceeded();
      } catch (error) {
        failAction(error);
        scheduleSilentRetry(error);
      }
      return settledState();
    }
    phase = { status: "connecting", email: account.email };
    try {
      await requireHealthyControlPlane();
      return await provision({
        accountToken: account.accountToken,
        user: { id: account.userId, email: account.email },
      });
    } catch (error) {
      if (expiredEmailSession(account, error)) return replaceExpiredEmailAccount(account, { signingOut: false });
      failAction(error, { email: account.email, expiredSessionIsSignedOut: true });
      return settledState();
    }
  };

  const retry = () => serialize(retryWork);

  const signOut = () => serialize(async () => {
    if (!storedAccount(credentials())) {
      await clearAfterCleanup();
      return settledState();
    }
    const account = storedAccount(credentials());
    const email = account?.email;
    phase = { status: "connecting", email };
    cancelSilentRetry();
    if (silentOn()) {
      // Written with the cleanup intent, before any remote call: a sign-out
      // interrupted halfway must not come back as a quiet re-registration.
      await updateCredentials((document) => ({
        ...document,
        [COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD]: true,
        [COMPANION_SILENT_OPT_OUT_FIELD]: true,
      }));
    }
    try {
      // Local access must stop even when the hosted control plane is down.
      // cleanupCurrentAccount first persists durable cleanup intent and stops
      // the connector, then attempts remote deletion/revocation with the
      // retained credentials. A failed remote step is retryable; a health
      // preflight here would leave paired-phone access live after Sign out.
      await cleanupCurrentAccount();
      // Successful owner-scoped reconciliation is stronger evidence than a
      // separate health probe and keeps the signed-out setup card available.
      healthy = true;
      lastHealthCheck = now();
      return settledState();
    } catch (error) {
      if (expiredEmailSession(account, error)) return replaceExpiredEmailAccount(account, { signingOut: true });
      failAction(error, { email });
      return settledState();
    }
  });

  const restore = () => serialize(async () => {
    if (!configured) return settledState();
    // Startup registers on its own only when there is a route to move or the
    // phone companion is on. Everyone else registers when they open the
    // connect screen, so an unused install never holds a hosted tunnel.
    const startupRegistration = () =>
      silentEnabled() &&
      !storedAccount(credentials()) &&
      (companionIsOn() || needsMove(credentials()));
    if (!(await probeWithRetries())) {
      if (
        startupRegistration() ||
        storedAccount(credentials())?.kind === INSTALLATION_ACCOUNT_KIND
      ) {
        scheduleSilentRetry();
      }
      return settledState();
    }
    const account = storedAccount(credentials());
    if (companionAccountCleanupPending(credentials()) && account) return retryWork();
    await ensureClientIdentity();
    if (account?.kind === INSTALLATION_ACCOUNT_KIND) return silentWork({ probed: true });
    if (account && !managedCompanionTunnelAccess(credentials())) return retryWork();
    if (startupRegistration()) return silentWork({ probed: true });
    phase = null;
    return settledState();
  });

  return Object.freeze({
    state: async () => {
      await probeControlPlane();
      // Opening the connect screen with no account here starts the quiet
      // registration (unless one is queued, waiting on backoff, or opted out).
      if (
        silentEnabled() &&
        !storedAccount(credentials()) &&
        silentTimer === null &&
        !silentQueued &&
        phase === null
      ) {
        silentQueued = true;
        phase = { status: "connecting" };
        void serialize(silentWork).catch(() => {}).finally(() => {
          silentQueued = false;
        });
      }
      return settledState();
    },
    requestCode,
    verifyCode,
    retry,
    signOut,
    restore,
  });
}
// branding compatibility (electron/branding-compat.json): environment-aliases: legacy launchd/systemd and provider subprocess environment labels stay accepted; the central resolver always prefers the new spelling
