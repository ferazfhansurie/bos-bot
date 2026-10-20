import { describe, expect, it, vi } from "vitest";

import { ControlPlaneError } from "./control-plane-client.mjs";
import {
  COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD,
  COMPANION_ACCOUNT_EMAIL_FIELD,
  COMPANION_ACCOUNT_KIND_FIELD,
  COMPANION_SILENT_OPT_OUT_FIELD,
  COMPANION_ACCOUNT_TOKEN_FIELD,
  COMPANION_ACCOUNT_USER_ID_FIELD,
  COMPANION_CLIENT_INSTANCE_FIELD,
  COMPANION_CONTROL_PLANE_ORIGIN_FIELD,
  COMPANION_INSTALLATION_CREDENTIAL_FIELD,
  COMPANION_INSTALLATION_EXPIRY_FIELD,
  COMPANION_INSTALLATION_ID_FIELD,
  companionAccountControlPlane,
  companionAccountSummary,
  createCompanionAccountService,
  controlPlaneUnavailableReason,
  resolveCompanionControlPlaneURL,
} from "./companion-account-service.mjs";
import {
  LEGACY_MANAGED_COMPANION_ENDPOINT_FIELD,
  LEGACY_MANAGED_COMPANION_GRACE_MS,
  LEGACY_MANAGED_COMPANION_RETIRE_AT_FIELD,
  LEGACY_MANAGED_COMPANION_TOKEN_FIELD,
  MANAGED_COMPANION_ENDPOINT_FIELD,
  MANAGED_COMPANION_ORIGIN_VERSION,
  MANAGED_COMPANION_ORIGIN_VERSION_FIELD,
  MANAGED_COMPANION_TOKEN_FIELD,
} from "./managed-companion-tunnel.mjs";

const UUID = "11111111-1111-4111-8111-111111111111";
const INSTALLATION_ID = "22222222-2222-4222-8222-222222222222";
const DUPLICATE_INSTALLATION_ID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_TOKEN = `signed.${"a".repeat(80)}`;
const INSTALLATION_CREDENTIAL = `omb_install_${"b".repeat(22)}.${"c".repeat(43)}`;
const CONNECTOR_TOKEN = `eyJ${"d".repeat(100)}`;
const ENDPOINT = "https://c-opaque.openmausbot.com";

function credentialStore(initial = {}) {
  let document = structuredClone(initial);
  const writes = [];
  return {
    read: () => structuredClone(document),
    update: vi.fn(async (derive) => {
      document = structuredClone(await derive(structuredClone(document)));
      writes.push(structuredClone(document));
      return structuredClone(document);
    }),
    writes,
  };
}

function readyClient(overrides = {}) {
  return {
    health: vi.fn(async () => true),
    requestOTP: vi.fn(async (email) => ({ email })),
    verifyOTP: vi.fn(async (email) => ({
      accountToken: ACCOUNT_TOKEN,
      user: { id: "user-1", email },
    })),
    ensureInstallation: vi.fn(async () => ({
      installation: {
        id: INSTALLATION_ID,
        clientInstanceId: UUID,
        name: "Test Mac",
        platform: "darwin",
      },
      credential: INSTALLATION_CREDENTIAL,
      credentialExpiresAt: Date.now() + 10_000,
    })),
    ensureEndpoint: vi.fn(async () => ({
      endpoint: { url: ENDPOINT },
      connectorToken: CONNECTOR_TOKEN,
    })),
    listInstallations: vi.fn(async () => []),
    deleteEndpoint: vi.fn(async () => {}),
    revokeInstallation: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    ...overrides,
  };
}

function serviceFixture({ initial, client = readyClient(), ...overrides } = {}) {
  const store = credentialStore(initial);
  const service = createCompanionAccountService({
    client,
    readCredentials: store.read,
    updateCredentials: store.update,
    identity: { name: "Test Mac", platform: "darwin", appVersion: "1.2.3" },
    newClientInstanceId: () => UUID,
    activatePersistedEndpoint: vi.fn(async () => ({ status: "ready", ready: true })),
    stopManagedEndpoint: vi.fn(async () => {}),
    managedConnectionState: () => ({ status: "ready", ready: true }),
    companionIsOn: () => true,
    ...overrides,
  });
  return { client, service, store };
}

function signedCredentials(overrides = {}) {
  return {
    [COMPANION_CLIENT_INSTANCE_FIELD]: UUID,
    [COMPANION_ACCOUNT_TOKEN_FIELD]: ACCOUNT_TOKEN,
    [COMPANION_ACCOUNT_USER_ID_FIELD]: "user-1",
    [COMPANION_ACCOUNT_EMAIL_FIELD]: "ada@example.com",
    [COMPANION_INSTALLATION_ID_FIELD]: INSTALLATION_ID,
    [COMPANION_INSTALLATION_CREDENTIAL_FIELD]: INSTALLATION_CREDENTIAL,
    [MANAGED_COMPANION_ENDPOINT_FIELD]: ENDPOINT,
    [MANAGED_COMPANION_TOKEN_FIELD]: CONNECTOR_TOKEN,
    [MANAGED_COMPANION_ORIGIN_VERSION_FIELD]: MANAGED_COMPANION_ORIGIN_VERSION,
    ...overrides,
  };
}

describe("Companion account service", () => {
  it("defaults to the BOS Bot control plane through the branding env proxy", async () => {
    const { compatEnvironment } = await import("./branding-env.cjs");
    const proxied = compatEnvironment({ HOME: "/tmp" });
    expect(resolveCompanionControlPlaneURL({ environment: proxied })).toBe("https://accounts.bosbot.my");
    expect(resolveCompanionControlPlaneURL({
      environment: compatEnvironment({ OMB_CONTROL_PLANE_URL: "https://legacy.example.com" }),
    })).toBe("https://legacy.example.com");
    expect(resolveCompanionControlPlaneURL({ environment: compatEnvironment({ BOS_CONTROL_PLANE_URL: "" }) })).toBe("");
  });

  it("defaults to the BOS Bot control plane and only uses an explicitly configured safe origin", () => {
    expect(resolveCompanionControlPlaneURL({ isPackaged: true, environment: {} })).toBe("https://accounts.bosbot.my");
    expect(resolveCompanionControlPlaneURL({ isPackaged: true, environment: { BOS_CONTROL_PLANE_URL: "" } })).toBe("");
    expect(controlPlaneUnavailableReason({ BOS_CONTROL_PLANE_URL: "" })).toMatch(/not configured.*BOS_CONTROL_PLANE_URL/);
    expect(controlPlaneUnavailableReason({ OMB_CONTROL_PLANE_URL: "ftp://x" })).toMatch(/OMB_CONTROL_PLANE_URL is set/);
    expect(resolveCompanionControlPlaneURL({
      isPackaged: true,
      environment: { BOS_CONTROL_PLANE_URL: "https://accounts.example.com/" },
    })).toBe("https://accounts.example.com");
    expect(resolveCompanionControlPlaneURL({
      isPackaged: true,
      environment: { BOS_CONTROL_PLANE_URL: "https://accounts.example.com", OMB_CONTROL_PLANE_URL: "https://legacy.example.com" },
    })).toBe("https://accounts.example.com");
    expect(resolveCompanionControlPlaneURL({
      isPackaged: false,
      environment: { OMB_CONTROL_PLANE_URL: "http://127.0.0.1:8787/" },
    })).toBe("http://127.0.0.1:8787");
    expect(resolveCompanionControlPlaneURL({
      isPackaged: true,
      environment: { OMB_CONTROL_PLANE_URL: "http://accounts.openmausbot.com" },
    })).toBe("");
    expect(resolveCompanionControlPlaneURL({
      isPackaged: true,
      environment: { OMB_CONTROL_PLANE_URL: new String("https://accounts.openmausbot.com") },
    })).toBe("");
    expect(resolveCompanionControlPlaneURL({ isPackaged: false, environment: {} })).toBe("https://accounts.bosbot.my");
  });

  it("moves an upstream account to this control plane and keeps its route retiring", async () => {
    const OWN = "https://accounts.bosbot.my";
    const NEW_ENDPOINT = "https://c-fresh.bosbot.my";
    const NEW_TOKEN = `eyJ${"e".repeat(100)}`;
    const client = readyClient({
      ensureEndpoint: vi.fn(async () => ({ endpoint: { url: NEW_ENDPOINT }, connectorToken: NEW_TOKEN })),
    });
    const stopManagedEndpoint = vi.fn(async () => {});
    const { service, store } = serviceFixture({
      initial: signedCredentials({ [COMPANION_ACCOUNT_USER_ID_FIELD]: "upstream-user" }),
      client,
      controlPlaneOrigin: OWN,
      stopManagedEndpoint,
      now: () => 1_000,
    });
    expect(companionAccountControlPlane(store.read())).toBe("upstream:openmausbot");

    // The upstream bearer is never offered to this control plane, and the
    // panel is told to ask for a sign-in instead of pairing via that route.
    expect(await service.state()).toMatchObject({ status: "signed-out", moveRequired: true });
    await service.restore();
    expect(store.read()[MANAGED_COMPANION_TOKEN_FIELD]).toBe(CONNECTOR_TOKEN);

    await service.requestCode("ada@example.com");
    const state = await service.verifyCode("ada@example.com", "12345678");
    expect(state).toMatchObject({ status: "ready", endpoint: NEW_ENDPOINT });
    expect(state.moveRequired).toBeUndefined();
    for (const call of [client.listInstallations, client.deleteEndpoint, client.revokeInstallation, client.signOut]) {
      expect(call).not.toHaveBeenCalled();
    }
    expect(stopManagedEndpoint).not.toHaveBeenCalled();
    expect(client.ensureInstallation).toHaveBeenCalledWith(expect.objectContaining({ currentCredential: "" }));
    const persisted = store.read();
    expect(persisted).toMatchObject({
      [COMPANION_CONTROL_PLANE_ORIGIN_FIELD]: OWN,
      [COMPANION_ACCOUNT_USER_ID_FIELD]: "user-1",
      [MANAGED_COMPANION_ENDPOINT_FIELD]: NEW_ENDPOINT,
      [MANAGED_COMPANION_TOKEN_FIELD]: NEW_TOKEN,
      [LEGACY_MANAGED_COMPANION_ENDPOINT_FIELD]: ENDPOINT,
      [LEGACY_MANAGED_COMPANION_TOKEN_FIELD]: CONNECTOR_TOKEN,
    });
    expect(persisted[LEGACY_MANAGED_COMPANION_RETIRE_AT_FIELD]).toBeGreaterThanOrEqual(LEGACY_MANAGED_COMPANION_GRACE_MS);
  });

  it("treats a route on openmausbot's domain as openmausbot's even when marked as ours", async () => {
    const OWN = "https://accounts.bosbot.my";
    const { service, store } = serviceFixture({
      initial: signedCredentials({ [COMPANION_CONTROL_PLANE_ORIGIN_FIELD]: OWN }),
      controlPlaneOrigin: OWN,
    });
    expect(companionAccountControlPlane(store.read())).toBe("upstream:openmausbot");
    expect(await service.state()).toMatchObject({ status: "signed-out", moveRequired: true });
    expect(companionAccountSummary(store.read(), OWN)).toContain("owner=openmausbot");
    expect(companionAccountSummary(store.read(), OWN)).not.toMatch(/eyJ|ada@/);
  });

  it("treats an unmarked account on its own hosted domain as local", async () => {
    const { client, service } = serviceFixture({
      initial: signedCredentials({ [MANAGED_COMPANION_ENDPOINT_FIELD]: "https://c-opaque.bosbot.my" }),
      controlPlaneOrigin: "https://accounts.bosbot.my",
    });
    expect(await service.state()).toMatchObject({ status: "ready", email: "ada@example.com" });
    expect(client.health).toHaveBeenCalled();
  });

  it("does not coerce boxed credential fields into an account", async () => {
    const initial = signedCredentials({
      [COMPANION_ACCOUNT_EMAIL_FIELD]: new String("ada@example.com"),
    });
    const { service } = serviceFixture({ initial });

    await expect(service.state()).resolves.toEqual({
      available: true,
      status: "signed-out",
    });
  });

  it("hides account onboarding until the configured control plane is healthy", async () => {
    const client = readyClient({
      health: vi.fn(async () => {
        throw new ControlPlaneError("request_failed", 404);
      }),
    });
    const { service } = serviceFixture({ client });

    await expect(service.restore()).resolves.toMatchObject({
      available: false,
      status: "signed-out",
    });
    await expect(service.requestCode("ada@example.com")).rejects.toThrow(
      "Secure access is not available right now",
    );
    expect(client.requestOTP).not.toHaveBeenCalled();
  });

  it("keeps an existing account recoverable while the control plane is unhealthy", async () => {
    const client = readyClient({
      health: vi.fn(async () => {
        throw new ControlPlaneError("network_unavailable");
      }),
    });
    const { service, store } = serviceFixture({ initial: signedCredentials(), client });

    await expect(service.restore()).resolves.toEqual({
      available: true,
      status: "error",
      email: "ada@example.com",
      endpoint: ENDPOINT,
      message: "Secure access is not available right now. Local pairing still works.",
    });
    expect(store.writes).toHaveLength(0);
  });

  it("discovers a control plane that becomes healthy without restarting the app", async () => {
    const health = vi
      .fn()
      .mockRejectedValueOnce(new ControlPlaneError("request_failed", 404))
      .mockResolvedValueOnce(true);
    const { service } = serviceFixture({
      client: readyClient({ health }),
      healthCacheMs: 0,
    });

    await expect(service.state()).resolves.toMatchObject({ available: false });
    await expect(service.state()).resolves.toEqual({ available: true, status: "signed-out" });
  });

  it("shows a specific rate-limit message instead of the generic secure-access error", async () => {
    const requestId = "44444444-4444-4444-8444-444444444444";
    const client = readyClient({
      requestOTP: vi.fn(async () => {
        throw new ControlPlaneError("rate_limited", 429, requestId);
      }),
    });
    const { service } = serviceFixture({ client });

    const request = service.requestCode("ada@example.com");
    await expect(request).rejects.toThrow("Too many attempts were made");
    await expect(request).rejects.toThrow(`Reference: ${requestId}`);
    await expect(request).rejects.not.toThrow("Secure access could not be updated");
  });

  it("does not classify local settled-state failures as request failures", async () => {
    const client = readyClient();
    const service = createCompanionAccountService({
      client,
      readCredentials: () => {
        throw new Error("credential store unavailable");
      },
    });

    await expect(service.requestCode("ada@example.com")).rejects.toThrow(
      "credential store unavailable",
    );
    expect(client.requestOTP).toHaveBeenCalledOnce();
  });

  it("persists one stable identity and the complete provision atomically", async () => {
    const activatePersistedEndpoint = vi.fn(async () => ({ status: "ready", ready: true }));
    const { client, service, store } = serviceFixture({ activatePersistedEndpoint });

    await service.requestCode(" Ada@Example.com ");
    const state = await service.verifyCode("Ada@example.com", "12345678");

    expect(state).toEqual({
      available: true,
      status: "ready",
      email: "ada@example.com",
      endpoint: ENDPOINT,
    });
    expect(client.ensureInstallation).toHaveBeenCalledWith({
      accountToken: ACCOUNT_TOKEN,
      currentCredential: "",
      clientInstanceId: UUID,
      name: "Test Mac",
      platform: "darwin",
      appVersion: "1.2.3",
    });
    const persisted = store.read();
    expect(persisted).toMatchObject({
      [COMPANION_CLIENT_INSTANCE_FIELD]: UUID,
      [COMPANION_ACCOUNT_TOKEN_FIELD]: ACCOUNT_TOKEN,
      [COMPANION_ACCOUNT_USER_ID_FIELD]: "user-1",
      [COMPANION_ACCOUNT_EMAIL_FIELD]: "ada@example.com",
      [COMPANION_INSTALLATION_ID_FIELD]: INSTALLATION_ID,
      [COMPANION_INSTALLATION_CREDENTIAL_FIELD]: INSTALLATION_CREDENTIAL,
      [MANAGED_COMPANION_ENDPOINT_FIELD]: ENDPOINT,
      [MANAGED_COMPANION_TOKEN_FIELD]: CONNECTOR_TOKEN,
      [MANAGED_COMPANION_ORIGIN_VERSION_FIELD]: MANAGED_COMPANION_ORIGIN_VERSION,
    });
    // First write creates the identity; the next single document contains
    // account, installation, endpoint, and connector material together.
    expect(store.writes).toHaveLength(2);
    expect(store.writes[1]).toMatchObject(persisted);
    expect(activatePersistedEndpoint).toHaveBeenCalledOnce();

    await service.restore();
    expect(store.writes).toHaveLength(2);
  });

  it("never exposes any bearer, connector token, installation ID, or credential", async () => {
    const { service } = serviceFixture({ initial: signedCredentials() });
    const state = await service.state();
    const publicJSON = JSON.stringify(state);

    for (const secret of [ACCOUNT_TOKEN, CONNECTOR_TOKEN, INSTALLATION_ID, INSTALLATION_CREDENTIAL]) {
      expect(publicJSON).not.toContain(secret);
    }
    expect(Object.keys(state).sort()).toEqual([
      "available",
      "email",
      "endpoint",
      "status",
    ]);
  });

  it("keeps an invalid code on the signed-out path with a friendly message", async () => {
    const client = readyClient({
      verifyOTP: vi.fn(async () => {
        throw new ControlPlaneError("invalid_otp", 400);
      }),
    });
    const { service } = serviceFixture({ client });

    await expect(service.verifyCode("ada@example.com", "00000000")).rejects.toThrow(
      "That code is not valid",
    );
    expect(await service.state()).toMatchObject({
      available: true,
      status: "signed-out",
      email: "ada@example.com",
    });
    expect(JSON.stringify(await service.state())).not.toContain("invalid_otp");
  });

  it("handles an expired account session without deleting recovery credentials", async () => {
    const client = readyClient({
      ensureInstallation: vi.fn(async () => {
        throw new ControlPlaneError("unauthorized", 401);
      }),
    });
    const incomplete = signedCredentials();
    delete incomplete[MANAGED_COMPANION_ENDPOINT_FIELD];
    delete incomplete[MANAGED_COMPANION_TOKEN_FIELD];
    const { service, store } = serviceFixture({ initial: incomplete, client });

    const state = await service.retry();

    expect(state).toMatchObject({
      status: "signed-out",
      email: "ada@example.com",
      message: expect.stringContaining("sign-in expired"),
    });
    expect(store.read()[COMPANION_ACCOUNT_TOKEN_FIELD]).toBe(ACCOUNT_TOKEN);
    expect(store.read()[COMPANION_INSTALLATION_CREDENTIAL_FIELD]).toBe(INSTALLATION_CREDENTIAL);
  });

  it("recovers from a network provisioning failure on retry", async () => {
    const ensureEndpoint = vi
      .fn()
      .mockRejectedValueOnce(new ControlPlaneError("network_unavailable"))
      .mockResolvedValueOnce({ endpoint: { url: ENDPOINT }, connectorToken: CONNECTOR_TOKEN });
    const client = readyClient({ ensureEndpoint });
    const incomplete = signedCredentials();
    delete incomplete[MANAGED_COMPANION_ENDPOINT_FIELD];
    delete incomplete[MANAGED_COMPANION_TOKEN_FIELD];
    const { service } = serviceFixture({ initial: incomplete, client });

    await expect(service.retry()).resolves.toMatchObject({
      status: "error",
      message: expect.stringContaining("Check your internet"),
    });
    await expect(service.retry()).resolves.toMatchObject({
      status: "ready",
      endpoint: ENDPOINT,
    });
  });

  it("keeps a verified session when setup fails so Retry can recover without another code", async () => {
    const ensureInstallation = vi
      .fn()
      .mockRejectedValueOnce(new ControlPlaneError("network_unavailable"))
      .mockResolvedValueOnce({
        installation: {
          id: INSTALLATION_ID,
          clientInstanceId: UUID,
          name: "Test Mac",
          platform: "darwin",
        },
        credential: INSTALLATION_CREDENTIAL,
      });
    const client = readyClient({ ensureInstallation });
    const { service, store } = serviceFixture({ client });

    await expect(service.verifyCode("ada@example.com", "12345678")).resolves.toMatchObject({
      status: "error",
      email: "ada@example.com",
      message: expect.stringContaining("Check your internet"),
    });
    expect(store.read()).toMatchObject({
      [COMPANION_CLIENT_INSTANCE_FIELD]: UUID,
      [COMPANION_ACCOUNT_TOKEN_FIELD]: ACCOUNT_TOKEN,
      [COMPANION_ACCOUNT_USER_ID_FIELD]: "user-1",
    });
    await expect(service.retry()).resolves.toMatchObject({ status: "ready", endpoint: ENDPOINT });
    expect(client.verifyOTP).toHaveBeenCalledOnce();
  });

  it("clears a verified-only session when setup failed before any remote material existed", async () => {
    const client = readyClient({
      ensureInstallation: vi.fn(async () => {
        throw new ControlPlaneError("network_unavailable");
      }),
    });
    const { service, store } = serviceFixture({ client });

    await expect(service.verifyCode("ada@example.com", "12345678")).resolves.toMatchObject({
      status: "error",
    });
    expect(store.read()).toMatchObject({
      [COMPANION_ACCOUNT_TOKEN_FIELD]: ACCOUNT_TOKEN,
      [COMPANION_ACCOUNT_USER_ID_FIELD]: "user-1",
    });

    await expect(service.signOut()).resolves.toEqual({ available: true, status: "signed-out" });
    expect(client.signOut).toHaveBeenCalledWith(ACCOUNT_TOKEN);
    expect(store.read()).toEqual({ [COMPANION_CLIENT_INSTANCE_FIELD]: UUID });
  });

  it("can switch accounts after setup failed before creating an installation", async () => {
    const nextAccountToken = `signed.${"z".repeat(80)}`;
    const ensureInstallation = vi
      .fn()
      .mockRejectedValueOnce(new ControlPlaneError("network_unavailable"))
      .mockResolvedValueOnce({
        installation: {
          id: INSTALLATION_ID,
          clientInstanceId: UUID,
          name: "Test Mac",
          platform: "darwin",
        },
        credential: INSTALLATION_CREDENTIAL,
      });
    const verifyOTP = vi
      .fn()
      .mockResolvedValueOnce({
        accountToken: ACCOUNT_TOKEN,
        user: { id: "user-1", email: "ada@example.com" },
      })
      .mockResolvedValueOnce({
        accountToken: nextAccountToken,
        user: { id: "user-2", email: "grace@example.com" },
      });
    const client = readyClient({ ensureInstallation, verifyOTP });
    const { service, store } = serviceFixture({ client });

    await service.verifyCode("ada@example.com", "12345678");
    await expect(service.verifyCode("grace@example.com", "87654321")).resolves.toEqual({
      available: true,
      status: "ready",
      email: "grace@example.com",
      endpoint: ENDPOINT,
    });
    expect(client.signOut).toHaveBeenCalledWith(ACCOUNT_TOKEN);
    expect(store.read()).toMatchObject({
      [COMPANION_ACCOUNT_TOKEN_FIELD]: nextAccountToken,
      [COMPANION_ACCOUNT_USER_ID_FIELD]: "user-2",
      [COMPANION_ACCOUNT_EMAIL_FIELD]: "grace@example.com",
    });
  });

  it("revokes an installation whose create response was lost before sign-out clears locally", async () => {
    const client = readyClient({
      ensureInstallation: vi.fn(async () => {
        throw new ControlPlaneError("network_unavailable");
      }),
      listInstallations: vi.fn(async () => [{
        id: INSTALLATION_ID,
        clientInstanceId: UUID,
        name: "Test Mac",
        platform: "darwin",
        appVersion: "1.2.3",
      }, {
        id: DUPLICATE_INSTALLATION_ID,
        clientInstanceId: UUID,
        name: "Lost duplicate",
        platform: "darwin",
        appVersion: "1.2.3",
      }]),
    });
    const { service, store } = serviceFixture({ client });

    await service.verifyCode("ada@example.com", "12345678");
    await expect(service.signOut()).resolves.toEqual({ available: true, status: "signed-out" });

    expect(client.listInstallations).toHaveBeenCalledWith(ACCOUNT_TOKEN);
    expect(client.revokeInstallation).toHaveBeenCalledWith(ACCOUNT_TOKEN, INSTALLATION_ID);
    expect(client.revokeInstallation).toHaveBeenCalledWith(
      ACCOUNT_TOKEN,
      DUPLICATE_INSTALLATION_ID,
    );
    expect(store.read()).toEqual({ [COMPANION_CLIENT_INSTANCE_FIELD]: UUID });
  });

  it("retains a response-lost session and cleanup intent when reconciliation is offline", async () => {
    const client = readyClient({
      ensureInstallation: vi.fn(async () => {
        throw new ControlPlaneError("network_unavailable");
      }),
      listInstallations: vi.fn(async () => {
        throw new ControlPlaneError("network_unavailable");
      }),
    });
    const { service, store } = serviceFixture({ client });

    await service.verifyCode("ada@example.com", "12345678");
    await expect(service.signOut()).resolves.toMatchObject({
      status: "error",
      email: "ada@example.com",
    });

    expect(store.read()).toMatchObject({
      [COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD]: true,
      [COMPANION_ACCOUNT_TOKEN_FIELD]: ACCOUNT_TOKEN,
      [COMPANION_ACCOUNT_USER_ID_FIELD]: "user-1",
      [COMPANION_CLIENT_INSTANCE_FIELD]: UUID,
    });
  });

  it("revokes an endpoint-ready installation whose provision response was lost", async () => {
    const client = readyClient({
      ensureEndpoint: vi.fn(async () => {
        throw new ControlPlaneError("network_unavailable");
      }),
      listInstallations: vi.fn(async () => [{
        id: INSTALLATION_ID,
        clientInstanceId: UUID,
        name: "Test Mac",
        platform: "darwin",
        appVersion: "1.2.3",
      }]),
    });
    const { service, store } = serviceFixture({ client });

    await service.verifyCode("ada@example.com", "12345678");
    await expect(service.signOut()).resolves.toEqual({ available: true, status: "signed-out" });

    expect(client.revokeInstallation).toHaveBeenCalledWith(ACCOUNT_TOKEN, INSTALLATION_ID);
    expect(store.read()).toEqual({ [COMPANION_CLIENT_INSTANCE_FIELD]: UUID });
  });

  it("cleans a response-lost endpoint before switching its stable UUID to another account", async () => {
    const nextAccountToken = `signed.${"n".repeat(80)}`;
    const verifyOTP = vi
      .fn()
      .mockResolvedValueOnce({
        accountToken: ACCOUNT_TOKEN,
        user: { id: "user-1", email: "ada@example.com" },
      })
      .mockResolvedValueOnce({
        accountToken: nextAccountToken,
        user: { id: "user-2", email: "grace@example.com" },
      });
    const ensureEndpoint = vi
      .fn()
      .mockRejectedValueOnce(new ControlPlaneError("network_unavailable"))
      .mockResolvedValueOnce({ endpoint: { url: ENDPOINT }, connectorToken: CONNECTOR_TOKEN });
    const client = readyClient({
      verifyOTP,
      ensureEndpoint,
      listInstallations: vi.fn(async (token) => token === ACCOUNT_TOKEN
        ? [{
            id: INSTALLATION_ID,
            clientInstanceId: UUID,
            name: "Test Mac",
            platform: "darwin",
            appVersion: "1.2.3",
          }]
        : []),
    });
    const { service, store } = serviceFixture({ client });

    await service.verifyCode("ada@example.com", "12345678");
    await expect(service.verifyCode("grace@example.com", "87654321")).resolves.toEqual({
      available: true,
      status: "ready",
      email: "grace@example.com",
      endpoint: ENDPOINT,
    });

    expect(client.revokeInstallation).toHaveBeenCalledWith(ACCOUNT_TOKEN, INSTALLATION_ID);
    expect(store.read()).toMatchObject({
      [COMPANION_ACCOUNT_TOKEN_FIELD]: nextAccountToken,
      [COMPANION_ACCOUNT_USER_ID_FIELD]: "user-2",
    });
  });

  it("stops locally and preserves every cleanup credential until revocation succeeds", async () => {
    const listInstallations = vi
      .fn()
      .mockRejectedValueOnce(new ControlPlaneError("network_unavailable"))
      .mockResolvedValueOnce([]);
    const client = readyClient({ listInstallations });
    const stopManagedEndpoint = vi.fn(async () => {});
    const { service, store } = serviceFixture({
      initial: signedCredentials(),
      client,
      stopManagedEndpoint,
    });

    const failed = await service.signOut();

    expect(failed).toMatchObject({ status: "error", email: "ada@example.com" });
    expect(stopManagedEndpoint).toHaveBeenCalled();
    expect(store.read()).toMatchObject({
      [COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD]: true,
      [COMPANION_ACCOUNT_TOKEN_FIELD]: ACCOUNT_TOKEN,
      [COMPANION_INSTALLATION_CREDENTIAL_FIELD]: INSTALLATION_CREDENTIAL,
      [MANAGED_COMPANION_TOKEN_FIELD]: CONNECTOR_TOKEN,
    });

    const recovered = await service.retry();
    expect(recovered).toEqual({ available: true, status: "signed-out" });
    expect(store.read()).toEqual({ [COMPANION_CLIENT_INSTANCE_FIELD]: UUID });
    expect(listInstallations).toHaveBeenCalledTimes(2);
  });

  it("stops hosted access before remote cleanup when the control plane is offline", async () => {
    const offline = async () => {
      throw new ControlPlaneError("network_unavailable");
    };
    const client = readyClient({
      health: vi.fn(offline),
      deleteEndpoint: vi.fn(offline),
      listInstallations: vi.fn(offline),
      revokeInstallation: vi.fn(offline),
    });
    const stopManagedEndpoint = vi.fn(async () => {});
    const { service, store } = serviceFixture({
      initial: signedCredentials(),
      client,
      stopManagedEndpoint,
    });

    await expect(service.signOut()).resolves.toMatchObject({
      status: "error",
      email: "ada@example.com",
    });

    expect(client.health).not.toHaveBeenCalled();
    expect(stopManagedEndpoint).toHaveBeenCalledOnce();
    expect(store.read()).toMatchObject({
      [COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD]: true,
      [COMPANION_ACCOUNT_TOKEN_FIELD]: ACCOUNT_TOKEN,
      [COMPANION_INSTALLATION_CREDENTIAL_FIELD]: INSTALLATION_CREDENTIAL,
      [MANAGED_COMPANION_TOKEN_FIELD]: CONNECTOR_TOKEN,
    });
  });

  it("uses a same-account reauthentication to finish pending cleanup instead of reprovisioning", async () => {
    const refreshedToken = `signed.${"r".repeat(80)}`;
    const client = readyClient({
      verifyOTP: vi.fn(async () => ({
        accountToken: refreshedToken,
        user: { id: "user-1", email: "ada@example.com" },
      })),
    });
    const initial = signedCredentials({
      [COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD]: true,
    });
    const { service, store } = serviceFixture({ initial, client });

    await expect(service.verifyCode("ada@example.com", "12345678")).resolves.toEqual({
      available: true,
      status: "signed-out",
    });
    expect(client.revokeInstallation).toHaveBeenCalledWith(refreshedToken, INSTALLATION_ID);
    expect(client.signOut).toHaveBeenCalledWith(refreshedToken);
    expect(client.ensureInstallation).not.toHaveBeenCalled();
    expect(client.ensureEndpoint).not.toHaveBeenCalled();
    expect(store.read()).toEqual({ [COMPANION_CLIENT_INSTANCE_FIELD]: UUID });
  });

  it("does not overwrite a previous account when switching cleanup fails", async () => {
    const newAccountToken = `signed.${"z".repeat(80)}`;
    const client = readyClient({
      verifyOTP: vi.fn(async () => ({
        accountToken: newAccountToken,
        user: { id: "user-2", email: "grace@example.com" },
      })),
      revokeInstallation: vi.fn(async () => {
        throw new ControlPlaneError("network_unavailable");
      }),
      listInstallations: vi.fn(async () => {
        throw new ControlPlaneError("network_unavailable");
      }),
    });
    const { service, store } = serviceFixture({ initial: signedCredentials(), client });

    await expect(service.verifyCode("grace@example.com", "12345678")).resolves.toMatchObject({
      status: "error",
      email: "ada@example.com",
      message: expect.stringContaining("Check your internet"),
    });
    expect(store.read()[COMPANION_ACCOUNT_USER_ID_FIELD]).toBe("user-1");
    expect(store.read()[COMPANION_ACCOUNT_TOKEN_FIELD]).toBe(ACCOUNT_TOKEN);
    expect(client.signOut).toHaveBeenCalledWith(newAccountToken);
  });

  it("treats an already removed installation as an idempotent sign-out", async () => {
    const client = readyClient({
      revokeInstallation: vi.fn(async () => {
        throw new ControlPlaneError("not_found", 404);
      }),
    });
    const { service, store } = serviceFixture({ initial: signedCredentials(), client });

    await expect(service.signOut()).resolves.toEqual({ available: true, status: "signed-out" });
    expect(store.read()).toEqual({ [COMPANION_CLIENT_INSTANCE_FIELD]: UUID });
  });
});

describe("silent installation-owned registration", () => {
  const OWN = "https://accounts.bosbot.my";
  const NEW_ENDPOINT = "https://c-fresh.bosbot.my";
  const OWN_ENDPOINT = "https://c-signed.bosbot.my";
  const NEW_TOKEN = `eyJ${"e".repeat(100)}`;
  const NEW_CREDENTIAL = `omb_install_${"f".repeat(22)}.${"g".repeat(43)}`;

  function silentClient(overrides = {}) {
    return readyClient({
      registerInstallation: vi.fn(async ({ clientInstanceId }) => ({
        installation: { id: INSTALLATION_ID, clientInstanceId, name: "Test Mac", platform: "darwin" },
        credential: NEW_CREDENTIAL,
        credentialExpiresAt: Date.now() + 90 * 24 * 60 * 60_000,
      })),
      inspectSelf: vi.fn(async () => ({
        installation: { id: INSTALLATION_ID, clientInstanceId: UUID },
        credentialExpiresAt: Date.now() + 90 * 24 * 60 * 60_000,
      })),
      rotateSelfCredential: vi.fn(async () => ({
        credential: INSTALLATION_CREDENTIAL,
        credentialExpiresAt: Date.now() + 90 * 24 * 60 * 60_000,
      })),
      revokeSelf: vi.fn(async () => {}),
      ensureEndpoint: vi.fn(async () => ({ endpoint: { url: NEW_ENDPOINT }, connectorToken: NEW_TOKEN })),
      ...overrides,
    });
  }

  function silentFixture({ client = silentClient(), ...overrides } = {}) {
    const timers = [];
    const fixture = serviceFixture({
      client,
      controlPlaneOrigin: OWN,
      silentRegistration: true,
      sleep: vi.fn(async () => {}),
      setTimer: vi.fn((callback, milliseconds) => {
        const timer = { callback, milliseconds };
        timers.push(timer);
        return timer;
      }),
      clearTimer: vi.fn(),
      ...overrides,
    });
    return { ...fixture, timers };
  }

  function installationOwned(overrides = {}) {
    return {
      [COMPANION_CLIENT_INSTANCE_FIELD]: UUID,
      [COMPANION_ACCOUNT_KIND_FIELD]: "installation",
      [COMPANION_CONTROL_PLANE_ORIGIN_FIELD]: OWN,
      [COMPANION_INSTALLATION_ID_FIELD]: INSTALLATION_ID,
      [COMPANION_INSTALLATION_CREDENTIAL_FIELD]: NEW_CREDENTIAL,
      [COMPANION_INSTALLATION_EXPIRY_FIELD]: Date.now() + 90 * 24 * 60 * 60_000,
      [MANAGED_COMPANION_ENDPOINT_FIELD]: NEW_ENDPOINT,
      [MANAGED_COMPANION_TOKEN_FIELD]: NEW_TOKEN,
      [MANAGED_COMPANION_ORIGIN_VERSION_FIELD]: MANAGED_COMPANION_ORIGIN_VERSION,
      ...overrides,
    };
  }

  it("registers on startup with no email and moves the openmausbot route to legacy", async () => {
    const client = silentClient();
    const onAccountChanged = vi.fn();
    const stopManagedEndpoint = vi.fn(async () => {});
    const { service, store } = silentFixture({
      initial: signedCredentials({ [COMPANION_ACCOUNT_USER_ID_FIELD]: "upstream-user" }),
      client,
      onAccountChanged,
      stopManagedEndpoint,
    });

    const state = await service.restore();
    expect(state).toMatchObject({ status: "ready", endpoint: NEW_ENDPOINT });
    expect(state.moveRequired).toBeUndefined();
    expect(client.registerInstallation).toHaveBeenCalledWith({
      clientInstanceId: UUID,
      name: "Test Mac",
      platform: "darwin",
      appVersion: "1.2.3",
    });
    for (const call of [client.requestOTP, client.verifyOTP, client.ensureInstallation, client.signOut,
      client.listInstallations, client.revokeInstallation, client.deleteEndpoint]) {
      expect(call).not.toHaveBeenCalled();
    }
    // The upstream connector keeps running until the new one replaces it.
    expect(stopManagedEndpoint).not.toHaveBeenCalled();
    expect(client.ensureEndpoint).toHaveBeenCalledWith(NEW_CREDENTIAL);

    const persisted = store.read();
    expect(persisted).toMatchObject({
      [COMPANION_ACCOUNT_KIND_FIELD]: "installation",
      [COMPANION_CONTROL_PLANE_ORIGIN_FIELD]: OWN,
      [COMPANION_INSTALLATION_ID_FIELD]: INSTALLATION_ID,
      [COMPANION_INSTALLATION_CREDENTIAL_FIELD]: NEW_CREDENTIAL,
      [MANAGED_COMPANION_ENDPOINT_FIELD]: NEW_ENDPOINT,
      [MANAGED_COMPANION_TOKEN_FIELD]: NEW_TOKEN,
      [LEGACY_MANAGED_COMPANION_ENDPOINT_FIELD]: ENDPOINT,
      [LEGACY_MANAGED_COMPANION_TOKEN_FIELD]: CONNECTOR_TOKEN,
    });
    expect(persisted[LEGACY_MANAGED_COMPANION_RETIRE_AT_FIELD]).toBeGreaterThan(Date.now() + LEGACY_MANAGED_COMPANION_GRACE_MS - 60_000);
    // The upstream account's bearer and identity are gone, never sent here.
    expect(persisted[COMPANION_ACCOUNT_TOKEN_FIELD]).toBeUndefined();
    expect(persisted[COMPANION_ACCOUNT_EMAIL_FIELD]).toBeUndefined();
    expect(persisted[COMPANION_ACCOUNT_USER_ID_FIELD]).toBeUndefined();

    // The startup log line proves the move.
    expect(companionAccountSummary(persisted, OWN)).toBe(
      "owner=this account=true primary=bosbot.my primaryUsable=true legacy=true cleanupPending=false",
    );
    expect(onAccountChanged).toHaveBeenCalled();
    expect(JSON.stringify(state)).not.toContain(NEW_CREDENTIAL);
    expect(JSON.stringify(state)).not.toContain(NEW_TOKEN);
  });

  it("starts registration when the connect screen asks for state", async () => {
    const client = silentClient();
    const { service } = silentFixture({ client, initial: {} });
    expect(await service.state()).toMatchObject({ status: "connecting" });
    await vi.waitFor(() => expect(client.ensureEndpoint).toHaveBeenCalled());
    await vi.waitFor(async () => expect(await service.state()).toMatchObject({ status: "ready", endpoint: NEW_ENDPOINT }));
    expect(client.registerInstallation).toHaveBeenCalledTimes(1);
  });

  it("keeps the current route and backs off quietly when registration fails", async () => {
    const client = silentClient({
      registerInstallation: vi.fn(async () => {
        throw new ControlPlaneError("rate_limited", 429);
      }),
    });
    const { service, store, timers } = silentFixture({
      client,
      initial: signedCredentials({ [COMPANION_ACCOUNT_USER_ID_FIELD]: "upstream-user" }),
    });
    const state = await service.restore();
    expect(state.status).toBe("error");
    expect(store.read()[MANAGED_COMPANION_ENDPOINT_FIELD]).toBe(ENDPOINT);
    expect(store.read()[MANAGED_COMPANION_TOKEN_FIELD]).toBe(CONNECTOR_TOKEN);
    expect(timers).toHaveLength(1);
    expect(timers[0].milliseconds).toBeGreaterThanOrEqual(60 * 60_000);

    client.registerInstallation.mockImplementation(async ({ clientInstanceId }) => ({
      installation: { id: INSTALLATION_ID, clientInstanceId },
      credential: NEW_CREDENTIAL,
      credentialExpiresAt: Date.now() + 90 * 24 * 60 * 60_000,
    }));
    timers[0].callback();
    await vi.waitFor(() => expect(store.read()[MANAGED_COMPANION_ENDPOINT_FIELD]).toBe(NEW_ENDPOINT));
    expect(store.read()[LEGACY_MANAGED_COMPANION_ENDPOINT_FIELD]).toBe(ENDPOINT);
  });

  it("revokes a registration it could not persist", async () => {
    const client = silentClient();
    const store = credentialStore({});
    let failNext = true;
    const { service } = silentFixture({
      client,
      initial: {},
      readCredentials: store.read,
      updateCredentials: vi.fn(async (derive) => {
        const next = await derive(store.read());
        if (next[COMPANION_ACCOUNT_KIND_FIELD] && failNext) {
          failNext = false;
          throw new Error("disk full");
        }
        return store.update(() => next);
      }),
    });
    await service.restore();
    expect(client.revokeSelf).toHaveBeenCalledWith(NEW_CREDENTIAL);
    expect(client.ensureEndpoint).not.toHaveBeenCalled();
  });

  it("retries the startup probe instead of trusting one slow answer", async () => {
    let calls = 0;
    const client = silentClient({
      health: vi.fn(async () => {
        calls += 1;
        if (calls < 3) throw new ControlPlaneError("network_unavailable");
        return true;
      }),
    });
    const sleep = vi.fn(async () => {});
    const { service } = silentFixture({ client, initial: installationOwned(), sleep });
    expect(await service.restore()).toMatchObject({ status: "ready", endpoint: NEW_ENDPOINT });
    expect(client.health).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("re-probes on retry with no account instead of replaying a cached failure", async () => {
    let up = false;
    const client = readyClient({
      health: vi.fn(async () => {
        if (!up) throw new ControlPlaneError("network_unavailable");
        return true;
      }),
    });
    // Headless: no silent registration, so retry only re-checks health.
    const { service } = serviceFixture({ client, initial: {}, controlPlaneOrigin: OWN });
    expect(await service.state()).toMatchObject({ status: "signed-out", available: false });
    up = true;
    expect(await service.retry()).toMatchObject({ status: "signed-out", available: true });
    expect(client.health).toHaveBeenCalledTimes(2);
  });

  it("only remembers a failed probe briefly", async () => {
    let clock = 0;
    let up = false;
    const client = readyClient({
      health: vi.fn(async () => {
        if (!up) throw new ControlPlaneError("network_unavailable");
        return true;
      }),
    });
    const { service } = serviceFixture({ client, initial: {}, now: () => clock });
    expect((await service.state()).available).toBe(false);
    up = true;
    clock = 6_000;
    expect((await service.state()).available).toBe(true);
  });

  it("re-registers when the server forgot this computer, keeping the retiring route", async () => {
    const client = silentClient({
      inspectSelf: vi.fn(async () => {
        throw new ControlPlaneError("unauthorized", 401);
      }),
      registerInstallation: vi.fn(async ({ clientInstanceId }) => ({
        installation: { id: DUPLICATE_INSTALLATION_ID, clientInstanceId },
        credential: INSTALLATION_CREDENTIAL,
        credentialExpiresAt: Date.now() + 90 * 24 * 60 * 60_000,
      })),
    });
    const { service, store } = silentFixture({
      client,
      initial: installationOwned({
        [LEGACY_MANAGED_COMPANION_ENDPOINT_FIELD]: ENDPOINT,
        [LEGACY_MANAGED_COMPANION_TOKEN_FIELD]: CONNECTOR_TOKEN,
        [LEGACY_MANAGED_COMPANION_RETIRE_AT_FIELD]: Date.now() + 1_000_000,
      }),
    });
    expect(await service.retry()).toMatchObject({ status: "ready" });
    expect(client.registerInstallation).toHaveBeenCalledTimes(1);
    expect(store.read()).toMatchObject({
      [COMPANION_INSTALLATION_ID_FIELD]: DUPLICATE_INSTALLATION_ID,
      [COMPANION_INSTALLATION_CREDENTIAL_FIELD]: INSTALLATION_CREDENTIAL,
      [LEGACY_MANAGED_COMPANION_ENDPOINT_FIELD]: ENDPOINT,
    });
  });

  it("renews a credential that is close to expiry", async () => {
    const client = silentClient({
      inspectSelf: vi.fn(async () => ({
        installation: { id: INSTALLATION_ID, clientInstanceId: UUID },
        credentialExpiresAt: Date.now() + 24 * 60 * 60_000,
      })),
    });
    const { service, store } = silentFixture({ client, initial: installationOwned() });
    await service.restore();
    expect(client.rotateSelfCredential).toHaveBeenCalledWith(NEW_CREDENTIAL);
    expect(store.read()[COMPANION_INSTALLATION_CREDENTIAL_FIELD]).toBe(INSTALLATION_CREDENTIAL);
  });

  it("signs out with the credential alone and does not quietly register again", async () => {
    const client = silentClient();
    const { service, store } = silentFixture({ client, initial: installationOwned() });
    expect(await service.signOut()).toMatchObject({ status: "signed-out" });
    expect(client.deleteEndpoint).toHaveBeenCalledWith(NEW_CREDENTIAL);
    expect(client.revokeSelf).toHaveBeenCalledWith(NEW_CREDENTIAL);
    expect(client.signOut).not.toHaveBeenCalled();
    expect(store.read()[COMPANION_SILENT_OPT_OUT_FIELD]).toBe(true);
    expect(store.read()[COMPANION_INSTALLATION_CREDENTIAL_FIELD]).toBeUndefined();

    await service.restore();
    expect(await service.state()).toMatchObject({ status: "signed-out" });
    expect(client.registerInstallation).not.toHaveBeenCalled();

    // Asking to connect a device again is consent.
    expect(await service.retry()).toMatchObject({ status: "ready" });
    expect(client.registerInstallation).toHaveBeenCalledTimes(1);
    expect(store.read()[COMPANION_SILENT_OPT_OUT_FIELD]).toBeUndefined();
  });

  it("waits for the connect screen when there is nothing to move and the companion is off", async () => {
    const client = silentClient();
    const { service } = silentFixture({ client, initial: {}, companionIsOn: () => false });
    await service.restore();
    expect(client.registerInstallation).not.toHaveBeenCalled();
    await service.state();
    await vi.waitFor(() => expect(client.registerInstallation).toHaveBeenCalledTimes(1));
  });

  it("registers on startup with no route to move when the companion is on", async () => {
    const client = silentClient();
    const { service } = silentFixture({ client, initial: {}, companionIsOn: () => true });
    expect(await service.restore()).toMatchObject({ status: "ready", endpoint: NEW_ENDPOINT });
  });

  it("never registers while the app says it cannot keep what it registers", async () => {
    const client = silentClient();
    const { service } = silentFixture({ client, initial: {}, silentRegistration: () => false });
    await service.restore();
    expect(await service.state()).toMatchObject({ status: "signed-out" });
    expect(client.registerInstallation).not.toHaveBeenCalled();
  });

  it("checks in daily so the credential never lapses", async () => {
    const client = silentClient();
    const { service, timers } = silentFixture({ client, initial: installationOwned() });
    await service.restore();
    expect(timers).toHaveLength(1);
    expect(timers[0].milliseconds).toBe(24 * 60 * 60_000);
    expect(client.inspectSelf).toHaveBeenCalledTimes(1);
    timers[0].callback();
    await vi.waitFor(() => expect(client.inspectSelf).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(timers).toHaveLength(2));
  });

  it("restarts the retiring route's grace when its replacement first exists", async () => {
    const client = silentClient();
    const { service, store } = silentFixture({
      client,
      initial: {
        [COMPANION_CLIENT_INSTANCE_FIELD]: UUID,
        [LEGACY_MANAGED_COMPANION_ENDPOINT_FIELD]: ENDPOINT,
        [LEGACY_MANAGED_COMPANION_TOKEN_FIELD]: CONNECTOR_TOKEN,
        [LEGACY_MANAGED_COMPANION_RETIRE_AT_FIELD]: Date.now() + 60_000,
      },
    });
    expect(await service.restore()).toMatchObject({ status: "ready", endpoint: NEW_ENDPOINT });
    expect(store.read()[LEGACY_MANAGED_COMPANION_RETIRE_AT_FIELD])
      .toBeGreaterThan(Date.now() + LEGACY_MANAGED_COMPANION_GRACE_MS - 60_000);
  });

  it("replaces an email account whose session expired, keeping its route as the retiring one", async () => {
    const client = silentClient({
      ensureInstallation: vi.fn(async () => {
        throw new ControlPlaneError("unauthorized", 401);
      }),
    });
    const { service, store } = silentFixture({
      client,
      initial: signedCredentials({
        [COMPANION_CONTROL_PLANE_ORIGIN_FIELD]: OWN,
        [MANAGED_COMPANION_ENDPOINT_FIELD]: OWN_ENDPOINT,
      }),
    });
    expect(await service.retry()).toMatchObject({ status: "ready", endpoint: NEW_ENDPOINT });
    expect(client.ensureInstallation).toHaveBeenCalledWith(expect.objectContaining({ accountToken: ACCOUNT_TOKEN }));
    expect(client.registerInstallation).toHaveBeenCalledTimes(1);
    expect(client.deleteEndpoint).not.toHaveBeenCalled();
    expect(store.read()).toMatchObject({
      [COMPANION_ACCOUNT_KIND_FIELD]: "installation",
      [LEGACY_MANAGED_COMPANION_ENDPOINT_FIELD]: OWN_ENDPOINT,
    });
    expect(store.read()[COMPANION_ACCOUNT_TOKEN_FIELD]).toBeUndefined();
    expect(store.read()[COMPANION_ACCOUNT_EMAIL_FIELD]).toBeUndefined();
  });

  it("finishes signing out an email account whose session expired", async () => {
    const client = silentClient({
      listInstallations: vi.fn(async () => {
        throw new ControlPlaneError("unauthorized", 401);
      }),
    });
    const { service, store } = silentFixture({
      client,
      initial: signedCredentials({
        [COMPANION_CONTROL_PLANE_ORIGIN_FIELD]: OWN,
        [MANAGED_COMPANION_ENDPOINT_FIELD]: OWN_ENDPOINT,
      }),
    });
    expect(await service.signOut()).toMatchObject({ status: "signed-out" });
    expect(client.listInstallations).toHaveBeenCalledWith(ACCOUNT_TOKEN);
    expect(client.deleteEndpoint).toHaveBeenCalledWith(INSTALLATION_CREDENTIAL);
    expect(client.registerInstallation).not.toHaveBeenCalled();
    expect(store.read()[COMPANION_ACCOUNT_TOKEN_FIELD]).toBeUndefined();
    expect(store.read()[MANAGED_COMPANION_ENDPOINT_FIELD]).toBeUndefined();
    expect(store.read()[COMPANION_SILENT_OPT_OUT_FIELD]).toBe(true);
  });

  it("records the opt-out before a sign-out reaches the network", async () => {
    const client = silentClient({
      revokeSelf: vi.fn(async () => {
        throw new ControlPlaneError("network_unavailable");
      }),
    });
    const { service, store, timers } = silentFixture({ client, initial: installationOwned() });
    expect(await service.signOut()).toMatchObject({ status: "error" });
    expect(store.read()[COMPANION_SILENT_OPT_OUT_FIELD]).toBe(true);
    expect(store.read()[COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD]).toBe(true);
    await service.restore();
    expect(client.registerInstallation).not.toHaveBeenCalled();
    expect(timers.every((timer) => timer.milliseconds !== 24 * 60 * 60_000)).toBe(true);
  });

  it("leaves email accounts on this control plane alone", async () => {
    const client = silentClient();
    const { service } = silentFixture({
      client,
      initial: signedCredentials({
        [COMPANION_CONTROL_PLANE_ORIGIN_FIELD]: OWN,
        [MANAGED_COMPANION_ENDPOINT_FIELD]: NEW_ENDPOINT,
      }),
    });
    expect(await service.restore()).toMatchObject({ status: "ready", email: "ada@example.com" });
    expect(await service.state()).toMatchObject({ status: "ready" });
    expect(client.registerInstallation).not.toHaveBeenCalled();
  });
});
// branding compatibility (electron/branding-compat.json): data-home: existing desktop and companion homes, backups and lease recovery must open the same data; deployed-services: existing worker databases, service health identities and hosted addresses must not become a different service; environment-aliases: legacy launchd/systemd and provider subprocess environment labels stay accepted; the central resolver always prefers the new spelling
