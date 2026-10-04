// Every update-button state from a mock /api/update, one per ?state=, for
// review screenshots. Not part of the app bundle (like mascot-preview).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { UpdatePill, UpdatesPanel, UpdateResultToast, type BusyEntry } from "@/components/BosUpdate";
import { updateNotice, type UpdateStatus, type UpdateView } from "@/lib/bos-update";
import type { Bot } from "@/state/store";
import "./styles.css";

const current = { version: "1.2.0", sha: "2d83ba23f1c0" };
const next = { version: "1.3.0", sha: "e4c28f147407" };
const candidate = {
  ...next,
  branch: "prod",
  notes: ["One-press update from the sidebar", "Bots finish their reply first and resume after", "Automatic rollback if the new build fails its check"],
};
const bots = [
  { id: "pix", name: "frontend bot", color: "blue", tasks: [{ threadId: "t1", title: "update button" }] },
  { id: "pipe", name: "backend bot", color: "violet", tasks: [{ threadId: "t2", title: "no-downgrade guard" }] },
] as unknown as Bot[];
const busyTurns = [
  { botId: "pix", threadId: "t1", botName: "frontend bot" },
  { botId: "pipe", threadId: "t2", botName: "backend bot" },
];
const busy: BusyEntry[] = [
  { key: "pix:t1", name: "frontend bot", bot: bots[0], threadTitle: "update button" },
  { key: "pipe:t2", name: "backend bot", bot: bots[1], threadTitle: "no-downgrade guard" },
];

const ready: UpdateStatus = { state: "ready", current, candidate, busyTurns };
const view = (status: UpdateStatus, patch: Partial<UpdateView> = {}): UpdateView => ({ status, state: status.state, offline: false, error: null, pending: null, checking: false, ...patch });
const run = (state: UpdateStatus["state"], patch: Partial<UpdateView> = {}) => view({ ...ready, state }, patch);
const settled = (lastResult: UpdateStatus["lastResult"], on = current, reason?: string) => view({ state: "idle", current: on, busyTurns: [], lastResult, reason });

const SCENES: Record<string, { view: UpdateView; busy: BusyEntry[]; confirm?: boolean; toast?: boolean }> = {
  "up-to-date": { view: view({ state: "idle", current: next, busyTurns: [], reason: "already on the newest prod build" }), busy: [] },
  checking: { view: view({ state: "idle", current: next, busyTurns: [] }, { checking: true }), busy: [] },
  ready: { view: view(ready), busy },
  confirm: { view: view(ready), busy, confirm: true },
  draining: { view: run("draining"), busy },
  checkpointing: { view: run("checkpointing"), busy },
  stopping: { view: run("stopping"), busy },
  building: { view: run("building", { detail: "prod e4c28f14" }), busy },
  applying: { view: run("applying"), busy },
  relaunching: { view: run("relaunching", { offline: true }), busy },
  verifying: { view: run("verifying", { detail: "/health" }), busy },
  updated: { view: settled({ state: "updated", at: Date.now(), from: current, to: next }, next, "already on the newest prod build"), busy: [], toast: true },
  "rolled-back": { view: settled({ state: "rolled_back", at: Date.now(), from: current, to: next, detail: "/health did not answer within 60s" }), busy: [], toast: true },
  failed: { view: settled({ state: "failed", at: Date.now(), from: current, to: next, detail: "build failed, nothing changed" }), busy: [], toast: true },
  conflict: { view: view(ready, { error: "Another update is already running." }), busy },
};

function Preview() {
  const name = new URLSearchParams(location.search).get("state") ?? "ready";
  const scene = SCENES[name] ?? SCENES.ready;
  const notice = updateNotice(scene.view.status);
  return (
    <div className="min-h-screen bg-app text-ink">
      <div className="flex">
        <aside className="w-[340px] shrink-0 border-r border-hairline/30 bg-panel">
          <div className="flex h-14 items-center justify-between px-3">
            <div className="flex gap-2 pl-1">
              <span className="size-3 rounded-full bg-[#ff5f57]" />
              <span className="size-3 rounded-full bg-[#febc2e]" />
              <span className="size-3 rounded-full bg-[#28c840]" />
            </div>
            <div className="flex items-center gap-1">
              <UpdatePill view={scene.view} onOpen={() => {}} />
              <span className="size-10" />
              <span className="size-10" />
            </div>
          </div>
          <div className="px-4 text-[12px] text-ink-secondary">scene: {name}</div>
        </aside>
        <main className="flex-1 p-6">
          <div className="mb-3 text-[15px] font-semibold">Updates</div>
          <div className="max-w-[640px]">
            <UpdatesPanel view={scene.view} busy={scene.busy} onApply={() => {}} onRestart={() => {}} onCheck={() => {}} initialConfirm={scene.confirm ? "apply" : null} />
          </div>
        </main>
      </div>
      {scene.toast && notice && <UpdateResultToast notice={notice} onDismiss={() => {}} />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
