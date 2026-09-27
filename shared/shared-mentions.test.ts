import { expect, it } from "vitest";
import { sharedMentionLabel, sharedMentionTargets, type SharedMentionIdentity } from "./shared-mentions";
const roster: SharedMentionIdentity[] = [
  { id: "h:person:maya", name: "Maya", kind: "person" },
  { id: "h:bot:maya", name: "Maya", kind: "bot", ownerName: "Alex" },
  { id: "h:person:alex", name: "Alex", kind: "person" },
  { id: "h:person:lee", name: "Alex Lee", kind: "person" },
];
it("disambiguates a person and bot with the same name", () => {
  expect(roster.map(item => sharedMentionLabel(item, roster))).toEqual(["Maya · person", "Maya · Alex", "Alex", "Alex Lee"]);
  expect(sharedMentionTargets("@Maya · person please review", roster)).toEqual(["h:person:maya"]);
  expect(sharedMentionTargets("@Maya · Alex please review", roster)).toEqual(["h:bot:maya"]);
  expect(sharedMentionTargets("@Maya please review", roster)).toEqual([]);
});
it("uses longest names and rejects unknown qualifiers", () => {
  expect(sharedMentionTargets("@Alex Lee please review", roster)).toEqual(["h:person:lee"]);
  expect(sharedMentionTargets("@Alex · missing please review", roster)).toEqual([]);
  expect(sharedMentionTargets("@Alex · person and @Alex Lee", roster)).toEqual(["h:person:alex", "h:person:lee"]);
});
it("never routes quoted, escaped or code examples", () => {
  expect(sharedMentionTargets('> @Maya · Alex\n\n`@Alex`\n\n```\n@Alex Lee\n```\n\n"@Alex" “@Alex” \\@Alex [@Alex](https://example.com) @Alex-more', roster)).toEqual([]);
});
it("keeps equal owner labels distinct regardless of roster order", () => {
  const equal: SharedMentionIdentity[] = [
    { id: "a:bot:m", name: "Maya", ownerName: "Alex", kind: "bot" },
    { id: "b:bot:m", name: "Maya", ownerName: "Alex", kind: "bot" },
  ];
  const label = sharedMentionLabel(equal[0], equal);
  expect(label).toBe(sharedMentionLabel(equal[0], [...equal].reverse()));
  expect(sharedMentionTargets(`@${label} hi`, equal)).toEqual([equal[0].id]);
  expect(sharedMentionTargets("@Maya · Alex hi", equal)).toEqual([]);
});
