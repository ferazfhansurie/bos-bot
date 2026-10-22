import { createParser } from "@openuidev/lang-core";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { library } from "./library";
import { SMART_UI_EXAMPLE, smartUiSkill } from "./prompt";

const SKILL = join(__dirname, "../../skills/smart-ui/SKILL.md");

describe("smart ui prompt", () => {
  it("skills/smart-ui/SKILL.md is generated from the library", () => {
    const generated = smartUiSkill();
    if (process.env.SMART_UI_WRITE === "1") writeFileSync(SKILL, generated);
    expect(readFileSync(SKILL, "utf8"), "run SMART_UI_WRITE=1 pnpm vitest run src/openui/prompt.test.ts").toBe(generated);
  });

  it("lists every component and function the renderer accepts", () => {
    const skill = smartUiSkill();
    for (const name of Object.keys(library.components)) expect(skill).toMatch(new RegExp(`^${name}\\(`, "m"));
    for (const name of Object.keys(library.functions)) expect(skill).toMatch(new RegExp(`^@${name}\\(`, "m"));
  });

  it("stays small: it rides along on every data turn", () => {
    // ~4 bytes a token; the budget is about 1.9k tokens.
    expect(Buffer.byteLength(smartUiSkill())).toBeLessThan(7600);
  });

  it("its example parses cleanly against the library", () => {
    const result = createParser(library.toJSONSchema(), "Col").parse(SMART_UI_EXAMPLE);
    expect(result.meta.errors).toEqual([]);
    expect(result.meta.unresolved ?? []).toEqual([]);
    expect(result.root?.typeName).toBe("Col");
  });
});
