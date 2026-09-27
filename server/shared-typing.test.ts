import { expect, it } from "vitest";
import { SharedTyping } from "./shared-typing.ts";
it("expires disconnected writers and excludes self, other rooms and removed members", () => {
  const typing = new SharedTyping();
  typing.update("one", "maya", true, 0);
  typing.update("two", "alex", true, 0);
  expect(typing.list("one", "alex", ["maya", "alex"], 100)).toEqual(["maya"]);
  expect(typing.list("one", "maya", ["maya", "alex"], 100)).toEqual([]);
  expect(typing.list("one", "alex", ["alex"], 100)).toEqual([]);
  expect(typing.list("one", "alex", ["maya", "alex"], 6000)).toEqual([]);
  typing.update("one", "maya", true, 7000);
  typing.update("one", "maya", false, 7001);
  expect(typing.list("one", "alex", ["maya"], 7002)).toEqual([]);
});
