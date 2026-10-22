import { randomUUID } from "node:crypto";
// The nonce is kept only once the server may hold it: after a prepared
// receipt, or after an ambiguous request (timeout, dropped connection). A
// definite refusal (busy 409, bad receipt) prepared nothing, so it is cleared.
// The server restores a prepared receipt under its new pid after a restart,
// so a pid change within this host generation rebinds the same nonce instead
// of wedging every later quit on "identity changed".
// With no owned, ready server there is no turn to protect: report idle and
// let the caller proceed. A company restore is not idle; getConnection throws.
export function createUpdateLifecycleClient({ getConnection, recordIntent, fetch: request = globalThis.fetch }) {
  let operation = null;
  async function prepareInstall() {
    const connection = getConnection();
    if (!connection) {
      operation = null;
      return { version: 1, state: "idle" };
    }
    const url = new URL(connection.url ?? "http://invalid");
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !/^[a-f0-9-]{36}$/.test(connection.generation ?? "") || !Number.isSafeInteger(connection.pid) || connection.pid <= 0 || !connection.token || typeof recordIntent !== "function") {
      throw new Error("Owned desktop server connection is unavailable");
    }
    // Another host generation can never hold this nonce.
    if (operation && operation.generation !== connection.generation) operation = null;
    if (operation) operation = { ...operation, pid: connection.pid, url: url.origin };
    operation ??= { generation: connection.generation, pid: connection.pid, url: url.origin, nonce: randomUUID() };
    const current = operation;
    let receipt;
    for (const action of ["prepare", "commit"]) {
      let response;
      try {
        response = await request(new URL("/api/desktop/lifecycle/update", url.origin), {
          method: "POST", headers: { "content-type": "application/json", "x-openmausbot-desktop-owner": connection.token },
          body: JSON.stringify({ action, expectedPid: current.pid, nonce: current.nonce }),
          signal: AbortSignal.timeout(15_000), redirect: "error",
        });
      } catch (error) {
        // Nothing listens on the owned port: the server is gone, nothing runs.
        if (action === "prepare" && error?.cause?.code === "ECONNREFUSED") {
          if (operation === current) operation = null;
          return { version: 1, state: "idle" };
        }
        throw error;
      }
      if (!response.ok) {
        if (action === "prepare" && operation === current) operation = null;
        throw new Error(`Update ${action} refused; installation remains held`);
      }
      receipt = await response.json();
      const validState = action === "commit" ? receipt?.state === "committed" : ["prepared", "committed"].includes(receipt?.state);
      if (receipt?.version !== 1 || receipt.generation !== current.generation || receipt.pid !== current.pid || receipt.nonce !== current.nonce || !validState || typeof receipt.preparedAt !== "string") {
        if (action === "prepare" && operation === current) operation = null;
        throw new Error("Update receipt identity mismatch; installation remains held");
      }
    }
    await recordIntent(receipt);
    return receipt;
  }
  return { prepareInstall };
}
// branding compatibility (electron/branding-compat.json): peer-http: HTTP authentication headers, discovery and domain verification still interoperate with 1.9.1
