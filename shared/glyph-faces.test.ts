import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CURSOR_STATES } from "../src/components/CursorAvatar";
import { MAUS_MOTIONS } from "../src/lib/mascot";
import {
  GLYPH_FACES, GLYPH_FACE_STATES, GLYPH_IDS, GLYPH_LAYOUT, GLYPH_PATHS, GLYPH_STROKE, GLYPH_TILT_DEG,
  MAUS_COLORS, MAUS_COLOR_NAMES, glyphFacesDocument, glyphFacesJson, glyphInk, glyphStateFor, resolveMausColor,
} from "./glyph-faces";
import { MASCOT_EYE_IDS, MASCOT_EYE_STYLES, botMascotEyes, mascotEyesSchema } from "./mascot-eyes";
import type { MascotGesture } from "./mascot-choreography";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

/** Minimal parser for the subset GLYPH_PATHS promises: absolute M, L, C, Z. */
function parsePath(d: string): { commands: string[]; points: Array<[number, number]> } {
  const ARGS: Record<string, number> = { M: 2, L: 2, C: 6, Z: 0 };
  const tokens = d.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
  expect(tokens.join(""), "only commands, numbers and separators").toBe(d.replace(/[\s,]+/g, ""));
  const commands: string[] = [];
  const points: Array<[number, number]> = [];
  let i = 0;
  while (i < tokens.length) {
    const command = tokens[i++];
    if (!(command in ARGS)) throw new Error(`unsupported command ${command} in ${d}`);
    if (commands.length === 0 && command !== "M") throw new Error(`path must start with M: ${d}`);
    commands.push(command);
    const count = ARGS[command];
    const args = tokens.slice(i, i + count).map(Number);
    if (args.length !== count || args.some((n) => !Number.isFinite(n))) throw new Error(`bad arguments for ${command} in ${d}`);
    i += count;
    for (let k = 0; k < count; k += 2) points.push([args[k], args[k + 1]]);
    if (i < tokens.length && /^-?[\d.]/.test(tokens[i])) throw new Error(`implicit repeated command after ${command} in ${d}`);
  }
  return { commands, points };
}

describe("glyph faces json", () => {
  it("shared/glyph-faces.json is generated from the ts (run `pnpm gen:glyphs`)", () => {
    const json = read("./glyph-faces.json");
    expect(json).toBe(glyphFacesJson());
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(glyphFacesDocument())));
  });

  it("the iOS CompanionCore copy is byte-identical", () => {
    expect(read("../ios/Sources/CompanionCore/Resources/glyph-faces.json")).toBe(read("./glyph-faces.json"));
  });

  it("the CompanionCore package bundles its Resources", () => {
    expect(read("../ios/Package.swift")).toMatch(/\.target\(name: "CompanionCore", resources: \[\.process\("Resources"\)\]\)/);
  });

  it("carries the frozen constants", () => {
    const doc = JSON.parse(read("./glyph-faces.json"));
    expect(doc.stroke).toBe(3.2);
    expect(doc.tiltDeg).toBe(-12);
    expect(GLYPH_STROKE).toBe(3.2);
    expect(GLYPH_TILT_DEG).toBe(-12);
    expect(doc.palette).toEqual(MAUS_COLORS);
  });
});

describe("glyph face table", () => {
  it("matches the plan's state table", () => {
    expect(GLYPH_FACES).toEqual({
      idle: { left: "dash", right: "dash", accent: null, anchor: null },
      thinking: { left: "caret", right: "caret", accent: "query", anchor: "left" },
      searching: { left: "ring", right: "ring", accent: "dots", anchor: "top-right" },
      working: { left: "plus", right: "plus", accent: "code", anchor: "top-right" },
      waiting: { left: "ring", right: "ring", accent: "bang", anchor: "left" },
      finished: { left: "gt", right: "lt", accent: "spark", anchor: "split" },
      happy: { left: "star", right: "star", accent: "heart", anchor: "top-right" },
      failed: { left: "cross", right: "cross", accent: null, anchor: null },
    });
    expect(Object.keys(GLYPH_FACES).sort()).toEqual([...GLYPH_FACE_STATES].sort());
  });

  it("every state's glyphs exist and accents come with an anchor", () => {
    for (const state of GLYPH_FACE_STATES) {
      const face = GLYPH_FACES[state];
      for (const id of [face.left, face.right, face.accent]) if (id !== null) expect(GLYPH_PATHS[id], `${state}: ${id}`).toBeTypeOf("string");
      expect(face.accent === null, state).toBe(face.anchor === null);
      if (face.anchor) expect(GLYPH_LAYOUT.accent[face.anchor], state).toBeDefined();
    }
    expect(Object.keys(GLYPH_PATHS).sort()).toEqual([...GLYPH_IDS].sort());
  });

  it("every path is valid M/L/C/Z path data inside the 24 box", () => {
    for (const id of GLYPH_IDS) {
      const { commands, points } = parsePath(GLYPH_PATHS[id]);
      expect(commands.length, id).toBeGreaterThan(1);
      for (const [x, y] of points) {
        expect(x, `${id} x`).toBeGreaterThanOrEqual(0);
        expect(x, `${id} x`).toBeLessThanOrEqual(24);
        expect(y, `${id} y`).toBeGreaterThanOrEqual(0);
        expect(y, `${id} y`).toBeLessThanOrEqual(24);
      }
    }
  });

  it("eye glyphs keep their GLYPH_STROKE inside the box", () => {
    const eyes = new Set(GLYPH_FACE_STATES.flatMap((state) => [GLYPH_FACES[state].left, GLYPH_FACES[state].right]));
    const half = GLYPH_STROKE / 2;
    for (const id of eyes) for (const [x, y] of parsePath(GLYPH_PATHS[id]).points) {
      expect(Math.min(x, y), id).toBeGreaterThanOrEqual(half);
      expect(Math.max(x, y), id).toBeLessThanOrEqual(24 - half);
    }
  });
});

describe("glyphStateFor", () => {
  it("maps every existing expression name to a glyph state, unknown -> idle", () => {
    const legacy = ["deadpan", "friendly", "focused", "thinking", "excited", "sleepy", "surprised", "skeptical", "worried", "mischievous"];
    const gestures: MascotGesture[] = ["idle", "thinking", "searching", "working", "waiting", "finished"];
    for (const name of [...CURSOR_STATES, ...legacy, ...MAUS_MOTIONS, ...gestures]) {
      expect(GLYPH_FACE_STATES, name).toContain(glyphStateFor(name));
    }
    expect(glyphStateFor(null)).toBe("idle");
    expect(glyphStateFor(undefined)).toBe("idle");
    expect(glyphStateFor("")).toBe("idle");
    expect(glyphStateFor("not-a-state")).toBe("idle");
    expect(glyphStateFor("toString")).toBe("idle");
    expect(glyphStateFor("__proto__")).toBe("idle");
  });

  it("sends the key expressions to the plan's faces", () => {
    expect(glyphStateFor("idle")).toBe("idle");
    expect(glyphStateFor("thinking")).toBe("thinking");
    expect(glyphStateFor("searching")).toBe("searching");
    expect(glyphStateFor("working")).toBe("working");
    expect(glyphStateFor("waiting")).toBe("waiting");
    expect(glyphStateFor("finished")).toBe("finished");
    expect(glyphStateFor("celebrate")).toBe("finished");
    expect(glyphStateFor("success")).toBe("finished");
    expect(glyphStateFor("happy")).toBe("happy");
    expect(glyphStateFor("friendly")).toBe("happy");
    expect(glyphStateFor("failure")).toBe("failed");
    expect(glyphStateFor("focused")).toBe("working");
    expect(glyphStateFor("deadpan")).toBe("idle");
  });

  it("lets decisive activity win", () => {
    expect(glyphStateFor("happy", "working")).toBe("working");
    expect(glyphStateFor(null, "working")).toBe("working");
    expect(glyphStateFor("thinking", "working")).toBe("thinking");
    expect(glyphStateFor("searching", "working")).toBe("searching");
    expect(glyphStateFor("happy", "waiting-on-you")).toBe("waiting");
    expect(glyphStateFor("working", "dead")).toBe("failed");
    expect(glyphStateFor("happy", "idle")).toBe("happy");
    expect(glyphStateFor("happy", "no-signal")).toBe("happy");
    expect(glyphStateFor(null, "idle")).toBe("idle");
  });
});

describe("resolveMausColor", () => {
  it("maps every named colour to its palette hex", () => {
    for (const name of MAUS_COLOR_NAMES) expect(resolveMausColor(name)).toBe(MAUS_COLORS[name]);
  });

  it("passes 6-digit hex through uppercased", () => {
    expect(resolveMausColor("#1e1e2e")).toBe("#1E1E2E");
    expect(resolveMausColor("#AbCdEf")).toBe("#ABCDEF");
    expect(resolveMausColor("#000000")).toBe("#000000");
  });

  it("falls back to green on anything else", () => {
    for (const junk of [null, undefined, "", "Green", "GREEN", " green", "#FFF", "#1E1E2EFF", "1E1E2E", "#GGGGGG", "#1E1E2E ", "rgb(0,0,0)", "toString", "constructor"]) {
      expect(resolveMausColor(junk), String(junk)).toBe("#009957");
    }
  });
});

describe("glyphInk", () => {
  it("picks the higher-contrast ink for every named colour", () => {
    expect(Object.fromEntries(MAUS_COLOR_NAMES.map((name) => [name, glyphInk(MAUS_COLORS[name])]))).toEqual({
      green: "#000000",
      blue: "#000000",
      red: "#000000",
      orange: "#000000",
      purple: "#FFFFFF",
      cyan: "#000000",
      pink: "#000000",
      yellow: "#000000",
      teal: "#000000",
      coral: "#000000",
      white: "#000000",
      brown: "#FFFFFF",
      gray: "#000000",
    });
  });

  it("handles hex and names", () => {
    expect(glyphInk("#000000")).toBe("#FFFFFF");
    expect(glyphInk("#FFFFFF")).toBe("#000000");
    expect(glyphInk("#1E1E2E")).toBe("#FFFFFF");
    expect(glyphInk("#1e1e2e")).toBe("#FFFFFF");
    expect(glyphInk("#FFEB3B")).toBe("#000000");
    expect(glyphInk("#3F51B5")).toBe("#FFFFFF");
    // both contrasts tie near luminance 0.179: #757575 sits just under, #767676 just over
    expect(glyphInk("#757575")).toBe("#FFFFFF");
    expect(glyphInk("#767676")).toBe("#000000");
    expect(glyphInk("white")).toBe("#000000");
    expect(glyphInk("junk")).toBe(glyphInk("#009957"));
  });
});

describe("mascot eyes", () => {
  it("defaults every bot to glyph and keeps an explicit pick", () => {
    expect(MASCOT_EYE_IDS).toContain("glyph");
    expect(MASCOT_EYE_STYLES.find((style) => style.id === "glyph")?.name).toBe("Glyph");
    expect(MASCOT_EYE_STYLES.map((style) => style.id)).toEqual([...MASCOT_EYE_IDS]);
    expect(botMascotEyes(null)).toBe("glyph");
    expect(botMascotEyes(undefined)).toBe("glyph");
    expect(botMascotEyes("future")).toBe("glyph");
    expect(botMascotEyes("glyph")).toBe("glyph");
    for (const id of ["classic", "round", "arches", "angled"] as const) expect(botMascotEyes(id)).toBe(id);
    expect(mascotEyesSchema.safeParse("glyph").success).toBe(true);
  });

  it("the team backup schema accepts the same eye ids", () => {
    const literal = read("./team-backup.ts").match(/mascotEyes: z\.enum\((\[[^\]]*\])\)/)?.[1];
    expect(literal && JSON.parse(literal)).toEqual([...MASCOT_EYE_IDS]);
  });
});
