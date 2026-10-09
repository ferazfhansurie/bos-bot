import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AppCrashScreen, AppErrorBoundary } from "./AppErrorBoundary";

describe("the app-wide crash screen", () => {
  it("says what happened in plain words, offers a reload, and carries the BOS brand", () => {
    const html = renderToStaticMarkup(createElement(AppCrashScreen, { detail: "Cannot read properties of undefined", onReload: () => {} }));
    expect(html).toContain("BOS Bot hit a problem");
    expect(html).toContain("Your bots, chats and settings are safe");
    expect(html).toMatch(/<button[^>]*>Reload<\/button>/);
    expect(html).toContain(">BOS<");
    expect(html).toContain('role="alert"');
    // the raw error is tucked away, not the headline
    expect(html).toContain("<details");
    expect(html).toContain("Cannot read properties of undefined");
    expect(html).not.toContain("Bos");
  });

  it("turns any thrown value into the crash state", () => {
    expect(AppErrorBoundary.getDerivedStateFromError(new Error("boom")).error.message).toBe("boom");
    expect(AppErrorBoundary.getDerivedStateFromError("plain string").error.message).toBe("plain string");
  });

  it("renders its children until something breaks, then the crash screen", () => {
    const child = createElement("p", null, "app");
    const boundary = new AppErrorBoundary({ children: child });
    expect(boundary.render()).toBe(child);
    boundary.state = { error: new Error("bad room markdown") };
    const fallback = boundary.render();
    expect(isValidElement(fallback) && fallback.type).toBe(AppCrashScreen);
    expect(renderToStaticMarkup(fallback as never)).toContain("bad room markdown");
  });

  it("logs the crash for diagnostics", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    new AppErrorBoundary({ children: null }).componentDidCatch(new Error("x"), { componentStack: "\n  at Room" });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
