import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PAGE_TABS_PER_THREAD, PageTabLog } from "./page-tab-log.ts";

describe("PageTabLog", () => {
  it("keeps pages per thread, newest first, one entry per path", () => {
    const log = new PageTabLog(null);
    log.record("b1", "t1", { path: "bos-pages/a.html", title: "A" }, 1);
    log.record("b1", "t1", { path: "bos-pages/b.html" }, 2);
    log.record("b1", "t1", { path: "bos-pages/a.html", title: "A again", appId: "a-x" }, 3);
    log.record("b1", "t2", { path: "bos-pages/c.html" }, 4);
    expect(log.list("b1", "t1")).toEqual([
      { path: "bos-pages/a.html", title: "A again", appId: "a-x", openedAt: 3 },
      { path: "bos-pages/b.html", openedAt: 2 },
    ]);
    expect(log.has("b1", "t1", "bos-pages/c.html")).toBe(false);
    expect(log.has("b2", "t1", "bos-pages/a.html")).toBe(false);
  });

  it("caps each thread and survives a restart", () => {
    const file = join(mkdtempSync(join(tmpdir(), "page-tabs-")), "page-tabs.json");
    const log = new PageTabLog(file);
    for (let i = 0; i < PAGE_TABS_PER_THREAD + 5; i++) log.record("b", "t", { path: `p${i}.html` }, i);
    const again = new PageTabLog(file).list("b", "t");
    expect(again).toHaveLength(PAGE_TABS_PER_THREAD);
    expect(again[0].path).toBe(`p${PAGE_TABS_PER_THREAD + 4}.html`);
  });
});
