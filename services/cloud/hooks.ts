import { CloudError } from "./identity.ts";
type Gate = {
  match: Record<string, string>;
  point: string;
  entered: boolean;
  waiting: number;
  release: () => void;
  promise: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
};
/** Test-only, constructed only by the loopback fictional fixture. 5s bound < request deadline. */
export class FixtureHooks {
  gates = new Map<string, Gate>();
  pausedWorker = false;
  dropNotify = false;
  workerFault: "none" | "before_complete" | "after_commit" = "none";
  arm(id: string, point: string, match: Record<string, string>) {
    if (this.gates.size >= 32 || this.gates.has(id))
      throw new CloudError("invalid_request", 400);
    let release = () => {};
    const promise = new Promise<void>((r) => {
      release = r;
    });
    const timer = setTimeout(() => {
      release();
      this.gates.delete(id);
    }, 5000);
    this.gates.set(id, {
      point,
      match,
      entered: false,
      waiting: 0,
      release,
      promise,
      timer,
    });
  }
  async hit(point: string, details: Record<string, string>) {
    for (const g of this.gates.values())
      if (
        g.point === point &&
        Object.entries(g.match).every(([k, v]) => details[k] === v)
      ) {
        g.entered = true;
        g.waiting++;
        await g.promise;
      }
  }
  release(id: string) {
    const g = this.gates.get(id);
    if (g) {
      clearTimeout(g.timer);
      g.release();
      this.gates.delete(id);
    }
  }
  state() {
    return [...this.gates.entries()].map(([id, g]) => ({
      id,
      point: g.point,
      entered: g.entered,
      waiting: g.waiting,
    }));
  }
  close() {
    for (const id of this.gates.keys()) this.release(id);
  }
}
