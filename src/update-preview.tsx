// Every update-button state from a mock /api/update, one per ?state=, for
// review screenshots. Not part of the app bundle (like mascot-preview).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConfirmUpdateDialog, UpdatePill, UpdatesPanel, UpdateResultToast, type BusyEntry } from "@/components/BosUpdate";
import { updateNotice, type UpdateStatus, type UpdateView } from "@/lib/bos-update";
import type { Bot } from "@/state/store";
import "./styles.css";

const current = { version: "1.2.0", sha: "2d83ba23f1c0" };
const candidate = {
  version: "1.3.0",
  sha: "9b1e44d07a2c",
  stagedAt: Date.now() - 6 * 60_000,
  notes: ["Update & restart from Settings, like codex", "Bots pause and pick up in the same thread", "Automatic rollback if the new build fails its check"],
};
const bots = [
  { id: "bos", name: "bos bot", color: "blue", tasks: [{ threadId: "t1", title: "geng · resume" }] },
  { id: "dev", name: "dev bot", color: "violet", tasks: [{ threadId: "t2", title: "1.3 handout" }] },
] as unknown as Bot[];
const busy: BusyEntry[] = [
  { key: "bos:t1", name: "bos bot", bot: bots[0], threadTitle: "geng · resume" },
  { key: "dev:t2", name: "dev bot", bot: bots[1], threadTitle: "1.3 handout" },
];

const ready: UpdateStatus = { state: "ready", current, candidate, busyTurns: [{ botId: "bos", threadId: "t1" }, { botId: "dev", threadId: "t2" }] };
const view = (status: UpdateStatus, patch: Partial<UpdateView> = {}): UpdateView => ({ status, state: status.state, offline: false, error: null, pending: null, ...patch });

const SCENES: Record<string, { view: UpdateView; busy: BusyEntry[]; confirm?: boolean; toast?: boolean }> = {
  "up-to-date": { view: view({ state: "idle", current, busyTurns: [] }), busy: [] },
  ready: { view: view(ready), busy },
  confirm: { view: view(ready), busy, confirm: true },
  stopping: { view: view({ ...ready, state: "stopping" }, { detail: "waiting for 2 bots, up to 90s" }), busy },
  applying: { view: view({ ...ready, state: "applying" }), busy },
  relaunching: { view: view({ ...ready, state: "relaunching" }, { offline: true }), busy },
  verifying: { view: view({ ...ready, state: "verifying" }, { detail: "8799, 8812, /health" }), busy },
  updated: { view: view({ state: "idle", current: { version: "1.3.0", sha: candidate.sha }, busyTurns: [], lastResult: { state: "done", at: Date.now() } }), busy: [], toast: true },
  "rolled-back": { view: view({ state: "idle", current, busyTurns: [], lastResult: { state: "rolled_back", at: Date.now(), detail: "/health did not answer within 60s", rollback: true } }), busy: [], toast: true },
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
            <UpdatesPanel view={scene.view} busy={scene.busy} onApply={() => {}} onRestart={() => {}} />
          </div>
        </main>
      </div>
      {scene.confirm && <ConfirmUpdateDialog kind="apply" version="1.3.0" busy={scene.busy} onConfirm={() => {}} onCancel={() => {}} />}
      {scene.toast && notice && <UpdateResultToast notice={notice} onDismiss={() => {}} />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
