// Glass for floating chrome only: the composer, the header pill, popovers and
// the sidebar. Never content cards — glass over glass turns to mud, and a card
// is something you read, not something that floats.
//
// With the v3 flag off this renders exactly the element it wraps: same tag,
// same classes, no extra attributes, so the pre-3.0 app is untouched. With v3
// on it adds `.bos-glass`, and the look itself lives in styles.css under the
// glass skins, so a flat skin worn with v3 on still renders flat.
//
// Refraction: a canvas-drawn displacement map bends the backdrop near the
// rounded edge, through an SVG filter referenced from backdrop-filter. Where
// that is unsupported, or transparency is reduced, CSS falls back to a plain
// blur or a solid fill.
import { useCallback, useEffect, useRef, useSyncExternalStore, type HTMLAttributes, type Ref } from "react";
import { cn } from "@/lib/cn";
import { useV3 } from "@/lib/v3";

const NS = "http://www.w3.org/2000/svg";
const DEFAULT_BEZEL = 16;
const DEFAULT_REFRACTION = 24;

export type GlassProps = HTMLAttributes<HTMLElement> & {
  as?: "div" | "aside" | "section" | "header";
  ref?: Ref<HTMLElement>;
  /** corner radius in px; defaults to whatever the element's css says */
  radius?: number;
  /** how far in from the edge the bend reaches, px */
  bezel?: number;
  /** how hard the edge bends the backdrop; 0 is a plain frosted blur */
  refraction?: number;
  /** what the element becomes when transparency is reduced or unsupported:
   * "blur" keeps a frosted fill, "solid" drops the backdrop entirely */
  fallback?: "blur" | "solid";
  /** a drop shadow for chrome that floats; off for chrome that docks */
  floating?: boolean;
};

export function Glass({
  as: As = "div",
  ref,
  radius,
  bezel = DEFAULT_BEZEL,
  refraction = DEFAULT_REFRACTION,
  fallback = "blur",
  floating = true,
  className,
  style,
  ...rest
}: GlassProps) {
  const v3 = useV3();
  const local = useRef<HTMLElement | null>(null);
  const active = useGlassActive() && v3;
  useRefraction(local, active && refraction > 0 && fallback === "blur", bezel, refraction, radius);

  const setNode = useCallback((node: HTMLElement | null) => {
    local.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  }, [ref]);

  if (!v3) return <As ref={setNode} className={className} style={style} {...rest} />;
  return (
    <As
      ref={setNode}
      className={cn(className, "bos-glass")}
      data-glass={fallback}
      data-glass-floating={floating ? "" : undefined}
      style={radius === undefined ? style : { ...style, borderRadius: radius }}
      {...rest}
    />
  );
}

// ── is liquid glass on, with transparency allowed ─────────────────────────

function glassActive(): boolean {
  if (typeof document === "undefined") return false;
  const root = document.documentElement;
  if (!("liquidGlass" in root.dataset)) return false;
  if ("reduceTransparency" in root.dataset) return false;
  try {
    return !window.matchMedia("(prefers-reduced-transparency: reduce)").matches;
  } catch {
    return true;
  }
}

function subscribeGlass(listener: () => void) {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-liquid-glass", "data-reduce-transparency"] });
  let media: MediaQueryList | undefined;
  try {
    media = window.matchMedia("(prefers-reduced-transparency: reduce)");
    media.addEventListener("change", listener);
  } catch {
    /* no media queries */
  }
  return () => {
    observer.disconnect();
    media?.removeEventListener("change", listener);
  };
}

function useGlassActive(): boolean {
  return useSyncExternalStore(subscribeGlass, glassActive, () => false);
}

// ── the refraction filter ─────────────────────────────────────────────────

let defs: SVGDefsElement | null = null;
let seq = 0;
const maps = new Map<string, string>();

function sharedDefs(): SVGDefsElement {
  if (defs?.isConnected) return defs;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.style.position = "absolute";
  svg.style.pointerEvents = "none";
  defs = document.createElementNS(NS, "defs");
  svg.append(defs);
  document.body.append(svg);
  return defs;
}

function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

/** A displacement map for a w×h rounded rect: red and green push pixels along
 * the edge normal, strongest at the rim and fading to nothing `bezel` px in. */
export function displacementMap(w: number, h: number, r: number, bezel: number): string {
  const key = `${w}x${h}r${r}b${bezel}`;
  const cached = maps.get(key);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const cx = w / 2, cy = h / 2, hx = w / 2 - r, hy = h / 2 - r;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - cx, py = y + 0.5 - cy;
      const qx = Math.abs(px) - hx, qy = Math.abs(py) - hy;
      let dist: number, nx: number, ny: number;
      if (qx > 0 && qy > 0) {
        const l = Math.hypot(qx, qy) || 1;
        dist = r - l; nx = qx / l; ny = qy / l;
      } else if (qx > qy) {
        dist = r - qx; nx = 1; ny = 0;
      } else {
        dist = r - qy; nx = 0; ny = 1;
      }
      nx *= Math.sign(px) || 1;
      ny *= Math.sign(py) || 1;
      const m = Math.pow(1 - Math.min(Math.max(dist / bezel, 0), 1), 2.4);
      const i = (y * w + x) * 4;
      d[i] = 128 - nx * m * 127;
      d[i + 1] = 128 - ny * m * 127;
      d[i + 2] = 128;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const url = canvas.toDataURL();
  // chrome comes in a handful of sizes; a resize drag must not grow this forever
  if (maps.size > 32) maps.delete(maps.keys().next().value!);
  maps.set(key, url);
  return url;
}

/** Red, green and blue each bend a little further than the last, so the rim
 * splits light the way thick glass does. */
const CHANNELS: Array<[string, number]> = [
  ["1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0", 1],
  ["0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0", 1.07],
  ["0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0", 1.14],
];

function useRefraction(
  target: React.RefObject<HTMLElement | null>,
  enabled: boolean,
  bezel: number,
  strength: number,
  radius: number | undefined,
) {
  useEffect(() => {
    const node = target.current;
    if (!enabled || !node || typeof ResizeObserver === "undefined") return;
    const id = `bos-glass-${++seq}`;
    const filter = svgEl("filter", {
      id, x: 0, y: 0,
      filterUnits: "userSpaceOnUse",
      primitiveUnits: "userSpaceOnUse",
      "color-interpolation-filters": "sRGB",
    });
    const image = svgEl("feImage", { x: 0, y: 0, preserveAspectRatio: "none", result: "map" });
    filter.append(svgEl("feGaussianBlur", { in: "SourceGraphic", stdDeviation: 2.2, result: "soft" }), image);
    const bends = CHANNELS.map(([matrix, k], j) => {
      const bend = svgEl("feDisplacementMap", { in: "soft", in2: "map", xChannelSelector: "R", yChannelSelector: "G", result: `d${j}` });
      filter.append(bend, svgEl("feColorMatrix", { in: `d${j}`, type: "matrix", values: matrix, result: `c${j}` }));
      return [bend, k] as const;
    });
    filter.append(
      svgEl("feBlend", { in: "c0", in2: "c1", mode: "screen", result: "rg" }),
      svgEl("feBlend", { in: "rg", in2: "c2", mode: "screen" }),
    );
    sharedDefs().append(filter);

    let size = "";
    const update = () => {
      const w = Math.round(node.offsetWidth), h = Math.round(node.offsetHeight);
      if (!w || !h || size === `${w}x${h}`) return;
      size = `${w}x${h}`;
      const r = Math.min(radius ?? (parseFloat(getComputedStyle(node).borderTopLeftRadius) || 0), w / 2, h / 2);
      const bz = Math.min(bezel, w / 2, h / 2);
      for (const el of [filter, image]) {
        el.setAttribute("width", String(w));
        el.setAttribute("height", String(h));
      }
      image.setAttribute("href", displacementMap(w, h, Math.round(r), Math.round(bz)));
      for (const [bend, k] of bends) bend.setAttribute("scale", String(strength * k));
      node.style.setProperty("--glass-filter", `url(#${id})`);
    };
    update();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(update, 140);
    });
    observer.observe(node);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      filter.remove();
      node.style.removeProperty("--glass-filter");
    };
  }, [target, enabled, bezel, strength, radius]);
}

