import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import schema from "../../shared/openui-schema.json" with { type: "json" };
import { library } from "./library";

// The server checks desk cards against this copy (it can't load the react
// library). After changing a component, regenerate it with
//   UPDATE_OPENUI_SCHEMA=1 npx vitest run src/openui/schema.test.ts
describe("openui schema copy", () => {
  it("matches the component library", () => {
    const live = JSON.parse(JSON.stringify(library.toJSONSchema()));
    if (process.env.UPDATE_OPENUI_SCHEMA === "1") writeFileSync(new URL("../../shared/openui-schema.json", import.meta.url), JSON.stringify(live));
    else expect(schema).toEqual(live);
  });
});
