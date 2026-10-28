// Skins are pure CSS. Every one of them is a block of custom properties in
// styles.css, selected by a `data-skin` attribute; this module only decides
// which one is active and remembers the choice. Nothing here knows a colour —
// that keeps the two halves from drifting apart, and it means adding a skin is
// one CSS block plus one line in SKINS.

export const SKIN_IDS = [
  "midnight",
  "atelier",
  "foundry",
  "lagoon",
  "graphite",
  "linen",
  "dusk",
  "daylight",
  "sakura",
  "blossom",
  "velvet",
] as const;
export type SkinId = (typeof SKIN_IDS)[number];

export type Skin = {
  id: SkinId;
  name: string;
  /** One line, shown under the name in the picker. */
  tagline: string;
};

export const SKINS: readonly Skin[] = [
  { id: "midnight", name: "Midnight", tagline: "The original. Cool and dark." },
  { id: "atelier", name: "Atelier", tagline: "Daylight on paper, warm and quiet." },
  { id: "foundry", name: "Foundry", tagline: "Night shift. Dark, warm, lit in brass." },
  { id: "lagoon", name: "Lagoon", tagline: "Cool daylight. Porcelain and deep teal." },
  { id: "graphite", name: "Graphite", tagline: "Quiet charcoal and softened steel blue." },
  { id: "linen", name: "Linen", tagline: "Clean daylight with a restrained navy accent." },
  { id: "dusk", name: "Dusk", tagline: "Muted plum after dark, calm and low-key." },
  { id: "daylight", name: "Daylight", tagline: "Midnight in reverse. Near-white, ink-black bubbles." },
  { id: "sakura", name: "Sakura", tagline: "Putri's pink, light or dark with the Mac." },
  { id: "blossom", name: "Blossom", tagline: "Soft pink daylight." },
  { id: "velvet", name: "Velvet", tagline: "Deep plum with pink accents." },
];

/** The skins the picker offers. Glass is a layer over any of them, not a skin. */
export function pickableSkins(_v3?: boolean): readonly Skin[] {
  return SKINS;
}

export const DEFAULT_SKIN: SkinId = "midnight";

const KEY = "omb-skin";
/** The flat skin someone wore before an early 3.0 build put them in a glass
 * skin. Read only to migrate those builds' "glass-dark"/"glass-light". */
const FLAT_KEY = "bos-v3-flat-skin";
/** Liquid glass under 3.0: "1" on, "0" off. Absent means 3.0 has never run
 * here, and the first run turns it on over whatever skin is worn. */
const GLASS_KEY = "bos-glass";

const LIGHT_FLAT: readonly SkinId[] = ["atelier", "lagoon", "linen", "daylight", "blossom"];
const DARK_FLAT: readonly SkinId[] = ["midnight", "foundry", "graphite", "dusk", "velvet"];

/** An early 3.0 build stored a glass skin. Glass is now a layer, so it
 * becomes the flat skin worn before it when that one has the same light or
 * dark, else Midnight or Daylight. */
export function migrateGlassSkin(legacy: string, stash: string | null | undefined): SkinId {
  const light = legacy === "glass-light";
  if (isSkinId(stash) && (light ? LIGHT_FLAT : DARK_FLAT).includes(stash)) return stash;
  return light ? "daylight" : "midnight";
}

// The input is whatever localStorage handed back — a string this app wrote
// on an earlier run, a value edited by hand, or a leftover from a renamed
// skin. The list is the schema.
function isSkinId(value: unknown): value is SkinId {
  // SAFETY: the assertion only satisfies includes()' parameter type; the
  // check itself is what decides, and a non-member returns false.
  return SKIN_IDS.includes(value as SkinId);
}

// Reaching for localStorage is itself a failure point: on an origin with
// storage blocked the getter throws, and `typeof` alone doesn't shield it.
function getStore(): Storage | undefined {
  try {
    // A bare feature test, not a narrowing of parsed input: in a renderer
    // without storage the identifier is simply not defined.
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/**
 * The skin to wear. A glass skin left by an early 3.0 build becomes its flat
 * skin here, once. With v3 on, the first run turns liquid glass on.
 */
export function readSkin(v3 = false): SkinId {
  try {
    const store = getStore();
    let stored = store?.getItem(KEY);
    if (stored === "glass-dark" || stored === "glass-light") {
      stored = migrateGlassSkin(stored, store?.getItem(FLAT_KEY));
      store?.setItem(KEY, stored);
    }
    if (v3 && store && store.getItem(GLASS_KEY) === null) store.setItem(GLASS_KEY, "1");
    return isSkinId(stored) ? stored : DEFAULT_SKIN;
  } catch {
    return DEFAULT_SKIN;
  }
}

/** Is liquid glass on? Only meaningful while v3 is on; a fresh install
 * counts as on, since its first 3.0 run puts it there. */
export function glassOn(): boolean {
  try {
    return getStore()?.getItem(GLASS_KEY) !== "0";
  } catch {
    return true;
  }
}

/** The liquid glass switch: remember it and frost (or unfrost) the skin
 * being worn. Never changes the skin or v3. */
export function setGlass(on: boolean): void {
  try {
    getStore()?.setItem(GLASS_KEY, on ? "1" : "0");
  } catch {
    /* the switch still applies for this session */
  }
  applyGlass(on);
}

/** Stamp glass on the document, over whichever skin is worn. Glass exists
 * only under v3, so callers pass `v3 && glassOn()`. */
export function applyGlass(on: boolean): void {
  if (on) document.documentElement.dataset.liquidGlass = "";
  else delete document.documentElement.dataset.liquidGlass;
}

/** A pick from the picker: just the skin. Glass stays as it was. */
export function pickSkin(id: SkinId): void {
  applySkin(id);
}

/**
 * Point the document at a skin and remember it. Called once before the first
 * paint (main.tsx) and again on every change from the picker — a stamped
 * attribute rather than a class so it can never collide with Tailwind.
 */
export function applySkin(id: SkinId): void {
  document.documentElement.dataset.skin = id;
  try {
    getStore()?.setItem(KEY, id);
  } catch {
    /* quota / private mode — the skin still applies for this session */
  }
  // The one surface CSS cannot reach: on Windows the caption buttons sit in a
  // native overlay the main process paints. Left at the default it stays
  // Midnight-black on a light skin — the "black block in the top-right
  // corner" of issue #454. Best-effort: a browser tab or an older desktop
  // build has no bridge, and the skin still applies without it.
  try {
    const chrome = id === "sakura"
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dusk" : "daylight")
      : id === "blossom" ? "daylight"
      : id === "velvet" ? "dusk" : id;
    void window.ogb?.applySkin?.(chrome)?.catch(() => undefined);
  } catch {
    /* no bridge */
  }
}
