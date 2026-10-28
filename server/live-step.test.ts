import { describe, expect, it } from "vitest";
import { commandStep, liveStep, planProgress, toolStep } from "./live-step.ts";

const tool = (name: string, input?: unknown, at = 10) => ({ kind: "activity", at, tool: { name, input: input === undefined ? undefined : JSON.stringify(input, null, 2) } });

describe("toolStep", () => {
  it("says what a tool does in plain words, with no paths or commands", () => {
    expect(toolStep("Read", undefined, JSON.stringify({ file_path: "/Users/x/server/retry.ts" })).line).toBe("reading retry.ts");
    expect(toolStep("Edit", undefined, JSON.stringify({ file_path: "/a/b/LiveActivityCoordinatorTests.swift" })).line).toBe("editing a file");
    expect(toolStep("Edit", undefined, JSON.stringify({ file_path: "/a/b/Clock.swift" })).line).toBe("editing Clock.swift");
    expect(toolStep("WebSearch").line).toBe("searching the web");
    expect(toolStep("WebFetch", undefined, JSON.stringify({ url: "https://www.apple.com/x" })).line).toBe("reading apple.com");
    expect(toolStep("mcp__agents__coordinate_bots").line).toBe("talking to the team");
    expect(toolStep("mcp__browser__agent_browser_open", undefined, JSON.stringify({ url: "https://adsmanager.facebook.com/" })).line).toBe("on adsmanager.facebook.com");
    expect(toolStep("mcp__computer__click").line).toBe("using the computer");
    expect(toolStep("SomethingNew").line).toBe("working on it");
  });

  it("keeps every line short and lowercase", () => {
    const names = ["Read", "Write", "Edit", "Bash", "Grep", "WebSearch", "WebFetch", "Task", "TodoWrite", "mcp__pipeboard__get_ads", "mcp__some_long_server_name_here__x", "mcp__browser__agent_browser_open"];
    for (const name of names) {
      const { line } = toolStep(name, "rm -rf /tmp/x && ls", JSON.stringify({ url: "https://a-very-long-subdomain.example-long-domain.com/", file_path: "/x/y.ts", command: "cd /x && ls" }));
      expect(line.length).toBeLessThanOrEqual(32);
      expect(line).toBe(line.toLowerCase().replace(/\.ts$/, ".ts"));
      expect(line).not.toMatch(/\/|rm -rf/);
    }
  });
});

describe("commandStep", () => {
  it("names the command by what it is for", () => {
    expect(commandStep("cd /repo && pnpm test -- live").line).toBe("running tests");
    expect(commandStep("git add -A && git commit -m x").line).toBe("saving the work");
    expect(commandStep("FOO=1 xcodebuild -scheme Bos build").line).toBe("building the app");
    expect(commandStep("ssh bos-server 'ls'").line).toBe("working on the server");
    expect(commandStep("curl -s https://bosbot.my").line).toBe("checking a website");
    expect(commandStep("git status --short").line).toBe("checking the code history");
    expect(commandStep("weird-binary --flag").line).toBe("running a command");
  });
});

describe("planProgress", () => {
  it("reads claude's TodoWrite and codex's update_plan", () => {
    const todos = tool("TodoWrite", { todos: [
      { content: "a", status: "completed", activeForm: "doing a" },
      { content: "b", status: "completed", activeForm: "doing b" },
      { content: "c", status: "in_progress", activeForm: "Editing `server/live-step.ts`" },
      { content: "d", status: "pending" }, { content: "e", status: "pending" },
    ] });
    expect(planProgress([todos])).toEqual({ stepIndex: 3, stepCount: 5, planStep: "editing live-step.ts" });
    const plan = tool("update_plan", { plan: [{ step: "x", status: "completed" }, { step: "ship it", status: "pending" }] });
    expect(planProgress([plan])).toEqual({ stepIndex: 2, stepCount: 2, planStep: "ship it" });
    expect(planProgress([tool("TodoWrite", { todos: [{ content: "only", status: "pending" }] })])).toEqual({});
  });
});

describe("liveStep", () => {
  it("uses this job's newest tool and ignores older turns and notices", () => {
    const messages = [tool("WebSearch", undefined, 1), { kind: "activity", at: 30, tool: { name: "auto-approved: Bash" } }, tool("Bash", { command: "pnpm test" }, 20)];
    expect(liveStep(messages, 10)).toMatchObject({ line: "running tests", symbol: "checkmark.seal" });
    expect(liveStep([tool("WebSearch", undefined, 1)], 10_000)).toBeUndefined();
  });
});
