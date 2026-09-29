import { randomUUID } from "node:crypto";
// A failed/ambiguous prepare retains its nonce. Never silently abandon a
// possibly prepared server and start another installation operation.
export function createUpdateLifecycleClient({ getConnection, recordIntent, fetch: request = globalThis.fetch }) {
  let operation = null;
  async function prepareInstall() {
    const connection = getConnection();
    const url = new URL(connection?.url ?? "http://invalid");
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !/^[a-f0-9-]{36}$/.test(connection?.generation ?? "") || !Number.isSafeInteger(connection?.pid) || connection.pid <= 0 || !connection.token || typeof recordIntent !== "function") {
      throw new Error("Owned desktop server connection is unavailable");
    }
    if (operation && (operation.generation !== connection.generation || operation.pid !== connection.pid || operation.url !== url.origin)) throw new Error("Update server identity changed; previous update remains held");
    operation ??= { generation: connection.generation, pid: connection.pid, url: url.origin, nonce: randomUUID() };
    let receipt;
    for (const action of ["prepare", "commit"]) {
      const response = await request(new URL("/api/desktop/lifecycle/update", url.origin), {
        method: "POST", headers: { "content-type": "application/json", "x-openmausbot-desktop-owner": connection.token },
        body: JSON.stringify({ action, expectedPid: operation.pid, nonce: operation.nonce }),
        signal: AbortSignal.timeout(15_000), redirect: "error",
      });
      if (!response.ok) throw new Error(`Update ${action} refused; installation remains held`);
      receipt = await response.json();
      const validState = action === "commit" ? receipt?.state === "committed" : ["prepared", "committed"].includes(receipt?.state);
      if (receipt?.version !== 1 || receipt.generation !== operation.generation || receipt.pid !== operation.pid || receipt.nonce !== operation.nonce || !validState || typeof receipt.preparedAt !== "string") {
        throw new Error("Update receipt identity mismatch; installation remains held");
      }
    }
    await recordIntent(receipt);
    return receipt;
  }
  return { prepareInstall };
}
