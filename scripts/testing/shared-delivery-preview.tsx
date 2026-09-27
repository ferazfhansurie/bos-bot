import { sharedDelivery } from "../../src/lib/shared-delivery";
// Test-owned bytes only. The browser picker itself is a separate check.
const room = new URLSearchParams(location.search).get("room");
if (room) sharedDelivery(`bot:shared:${room}:shared:${room}`).setFiles(() => [
  new File(["Synthetic delivery fixture"], "delivery-check.txt", { type: "text/plain" }),
]);
await import("./threads-preview");
