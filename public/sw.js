// Browser notifications for BOS Bot in a plain browser tab (app.bosbot.my,
// remote access). The server sends web push (server/web-push.ts) when a bot
// finishes, asks, or someone messages; this shows it even with the tab
// closed, and a click opens the exact bot, thread and message.
//
// Kept dependency-free and tiny: it is served as-is from the site root so its
// scope covers the whole app, and with no-cache so a fix lands on next load.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function windows() {
  return self.clients.matchAll({ type: "window", includeUncontrolled: true });
}

self.addEventListener("push", (event) => {
  let message;
  try { message = event.data ? event.data.json() : null; } catch { message = null; }
  if (!message || typeof message.title !== "string") return;
  event.waitUntil(windows().then((open) => {
    // The open page already shows its own banner for what it can see; a
    // focused tab needs no second one. Same tag either way, so a page banner
    // and this one replace each other instead of stacking.
    if (open.some((client) => client.focused && client.visibilityState === "visible")) return;
    return self.registration.showNotification(message.title, {
      body: message.body || "",
      tag: message.tag || undefined,
      requireInteraction: Boolean(message.sticky),
      icon: "/app-icon.png",
      badge: "/app-icon.png",
      data: message.data || {},
    });
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data || {};
  event.waitUntil(windows().then(async (open) => {
    const client = open.find((candidate) => candidate.focused) || open[0];
    if (client) {
      await client.focus().catch(() => {});
      client.postMessage({ type: "bos:notification-open", target });
      return;
    }
    const url = new URL(self.registration.scope);
    url.searchParams.set("bos-open", JSON.stringify(target));
    await self.clients.openWindow(url.href);
  }));
});
