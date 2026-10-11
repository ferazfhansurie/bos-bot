import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

it("hydrates local conversations while a linked home is slow, without duplicate room refreshes", async () => {
  let groupRequests = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const remote = createServer((req, res) => {
    if (req.url === "/api/groups") groupRequests++;
    const timer = setTimeout(() => {
      timers.delete(timer);
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "fixture home is unavailable" }));
    }, 1500);
    timers.add(timer);
  });
  await new Promise<void>(resolve => remote.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(remote.address() as AddressInfo).port}`;
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, [], undefined, {
    origin,
    prepare(dataDir) {
      writeFileSync(join(dataDir, "multiplayer-links.json"), JSON.stringify({ version: 1, links: [{
        homeId: "slow-fixture", name: "Slow fixture", origin: "https://delegated-fixture.example.ts.net:8443",
        token: `omb_sess_${"f".repeat(43)}`, bots: [], proxyGroups: {},
        joinedGroups: [{ id: "remote-room", name: "Remote fixture", threadIds: ["remote-thread"] }],
      }] }));
    },
  });
  try {
    const created = await fetch(`${fixture.info.url}/api/bots`, {
      method: "POST", headers: { "content-type": "application/json", origin: fixture.info.url },
      body: JSON.stringify({ name: "Local fixture" }),
    });
    expect(created.status).toBe(201);
    const { bot } = await created.json() as any;
    for (let i = 0; i < 2; i++) {
      const start = performance.now();
      const response = await fetch(`${fixture.info.url}/api/bots?messages=50`);
      const fleet = await response.json() as any;
      const elapsed = performance.now() - start;
      expect(response.status).toBe(200);
      expect(elapsed).toBeLessThan(800);
      expect(fleet.bots.some((item: any) => item.id === bot.id)).toBe(true);
      expect(fleet.groups.find((item: any) => item.id === "remote-room")?.home.available).toBe(false);
      console.log(`isolated fleet ${i + 1}: ${Math.round(elapsed)}ms, local bot present, remote unavailable`);
    }
    expect(groupRequests).toBe(1);
  } finally {
    await fixture.close();
    for (const timer of timers) clearTimeout(timer);
    remote.closeAllConnections();
    await new Promise<void>(resolve => remote.close(() => resolve()));
  }
}, 30_000);
