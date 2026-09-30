import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as Array<() => unknown>, request: vi.fn(), status: vi.fn() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const i = f.index++; if (!(i in f.values)) f.values[i] = initial; return [f.values[i], (v: any) => { f.values[i] = typeof v === "function" ? v(f.values[i]) : v; }]; },
  useEffect: (fn: () => unknown) => { f.effects.push(fn); },
}));
const { RemoteFullAccess } = await import("./RemoteFullAccess");
type Node = ReactElement<{ children?: ReactNode; onClick?: () => Promise<void> | void; onChange?: (e: any) => void; type?: string; disabled?: boolean; role?: string }>;
const nodes = (v: ReactNode): Node[] => isValidElement(v) ? [v as Node, ...Children.toArray((v as Node).props.children).flatMap(nodes)] : [];
const candidates = [{ botId: "sol", threadId: "s", name: "Sol", busy: false }, { botId: "opus", threadId: "o", name: "Opus", busy: false }];
function render() { f.index = 0; return nodes(RemoteFullAccess({ botId: "sol", threadId: "selected", busy: false, candidates })); }
const button = (tree: Node[], text: string) => tree.find(n => n.type === "button" && n.props.children === text)!;
beforeEach(() => { f.values = []; f.effects = []; f.request.mockReset().mockResolvedValue({ applied: true }); f.status.mockReset().mockResolvedValue({ protocol: 1, enrolled: true, state: "verified" }); vi.stubGlobal("window", { ogb: { remoteApprovals: { status: f.status, request: f.request } } }); });
it("exposes no Full request without both native bridge and server capability", async () => {
  f.status.mockResolvedValue({ protocol: 0, enrolled: false }); expect(render()).toHaveLength(0); f.effects.shift()!(); await Promise.resolve(); expect(render()).toHaveLength(0); expect(f.request).not.toHaveBeenCalled();
});
it("selects two bots for one native batch and pins the current selected task", async () => {
  render(); f.effects.shift()!(); await Promise.resolve(); let tree = render();
  await button(tree, "Full access…").props.onClick!(); tree = render();
  const checkboxes = tree.filter(n => n.type === "input"); checkboxes[1].props.onChange!({ target: { checked: true } }); tree = render();
  await button(tree, "Review with owner").props.onClick!();
  expect(f.request).toHaveBeenCalledExactlyOnceWith([{ botId: "sol", threadId: "selected", updateBotDefault: true }, { botId: "opus", threadId: "o", updateBotDefault: true }]);
});
it("cancel does not request approval; native refusal stays visible", async () => {
  render(); f.effects.shift()!(); await Promise.resolve(); let tree = render(); await button(tree, "Full access…").props.onClick!(); tree = render();
  button(tree, "Cancel").props.onClick!(); expect(f.request).not.toHaveBeenCalled();
  await button(render(), "Full access…").props.onClick!(); f.request.mockRejectedValue(new Error("not owner")); await button(render(), "Review with owner").props.onClick!();
  expect(render().some(n => n.props.role === "alert")).toBe(true);
});

it.each(["pending", "missing", "unavailable", undefined])("does not expose Full for unverified readiness %s, even with legacy enrolled=true", async state => {
  f.status.mockResolvedValue({ protocol: 1, enrolled: true, state });
  render(); f.effects.shift()!(); await Promise.resolve(); expect(render()).toHaveLength(0); expect(f.request).not.toHaveBeenCalled();
});
it("pending/failed readiness can transition to verified after exact enrollment retry", async () => {
  f.status.mockResolvedValue({ protocol: 1, enrolled: false, state: "pending" });
  render(); f.effects.shift()!(); await Promise.resolve(); expect(render()).toHaveLength(0);
  f.status.mockResolvedValue({ protocol: 1, enrolled: true, state: "verified" });
  f.effects.pop()!(); await Promise.resolve(); expect(button(render(), "Full access…")).toBeDefined();
});
it.each(["revoked", "unavailable", "pending"])("rechecks readiness on click and suppresses stale Full for %s", async reason => {
  render(); f.effects.shift()!(); await Promise.resolve(); const tree = render();
  if (reason === "unavailable") f.status.mockRejectedValue(new Error("offline"));
  else f.status.mockResolvedValue({ protocol: 1, enrolled: false, state: reason === "pending" ? "pending" : "unavailable" });
  await button(tree, "Full access…").props.onClick!(); expect(render()).toHaveLength(0); expect(f.request).not.toHaveBeenCalled();
});
it("a previously verified task cannot lend readiness to another task", async () => {
  render(); f.effects.shift()!(); await Promise.resolve(); expect(button(render(), "Full access…")).toBeDefined();
  f.index = 0; expect(nodes(RemoteFullAccess({ botId: "sol", threadId: "other", busy: false, candidates }))).toHaveLength(0);
});
