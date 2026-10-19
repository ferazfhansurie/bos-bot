import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WebhookManager } from "./webhooks.ts";
import { listenWebhookIngress } from "./webhook-ingress.ts";

it("authenticates a named provider relay, verifies exact source filters before activation and deduplicates real HTTP events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bos-named-events-")); const queued: any[] = [];
  const file = join(dir, "webhooks.json");
  const manager = new WebhookManager({ file, botState: () => "ready", enqueue: input => { queued.push(input); return { id: `run-${queued.length}` }; } });
  const ingress = await listenWebhookIngress(manager, { port: 0 });
  try {
    const created = manager.create({ name: "PR opened", prompt: "Review PR", botId: "fixture", enabled: false, verificationPending: true, eventSource: { kind: "github-pr", repository: "fixture/repo", action: "opened" } });
    const send = (payload: unknown, secret = created.secret, event = "pull_request", id = "delivery-one") => fetch(`${ingress.baseUrl}/hooks/${created.webhook.endpointId}`, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", "x-webhook-event": event, "idempotency-key": id }, body: JSON.stringify(payload) });
    const good = { repository: { full_name: "fixture/repo" }, action: "opened", pull_request: { number: 42 } };
    expect((await send(good, "wrong")).status).toBe(401);
    expect(await (await send({ ...good, repository: { full_name: "other/repo" } })).json()).toMatchObject({ ignored: true });
    expect(manager.list()[0]?.verificationSample).toBeUndefined();
    expect(await (await send(good)).json()).toMatchObject({ captured: true });
    expect(queued).toHaveLength(0);
    manager.update(created.webhook.id, { enabled: true, verificationPending: false });
    expect(await (await send(good)).json()).toMatchObject({ runId: "run-1" });
    expect(await (await send(good)).json()).toMatchObject({ duplicate: true });
    expect(await (await send({ ...good, action: "closed" }, created.secret, "pull_request", "two")).json()).toMatchObject({ ignored: true });
    expect(await (await send({ ...good, pull_request: undefined }, created.secret, "pull_request", "three")).json()).toMatchObject({ ignored: true });
    expect(queued).toHaveLength(1); expect(queued[0].prompt).toContain('"number": 42');
    expect(JSON.stringify(manager.list())).not.toContain(created.secret);
    const restored = new WebhookManager({ file, botState: () => "ready", enqueue: () => ({ id: "unexpected" }) });
    expect(restored.list()[0]?.eventSource).toEqual({ kind: "github-pr", repository: "fixture/repo", action: "opened" });
    const slack = manager.create({ name: "mentions", prompt: "Check mention", botId: "fixture", eventSource: { kind: "slack-mention", teamId: "T123ABC", channelId: "C123ABC" } });
    expect(manager.receive(slack.webhook.endpointId, slack.secret, { eventName: "app_mention", payload: { team_id: "TOTHER", event: { type: "app_mention", channel: "C123ABC" } } })).toMatchObject({ ignored: true });
    expect(manager.receive(slack.webhook.endpointId, slack.secret, { eventName: "event_callback", payload: { team_id: "T123ABC", event: { type: "app_mention", channel: "C123ABC" } } })).toHaveProperty("runId");
    expect(() => manager.create({ name: "bad", prompt: "", botId: "fixture", eventSource: { kind: "github-ci", repository: "*" } })).toThrow();
  } finally { await new Promise<void>(resolve => ingress.server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
