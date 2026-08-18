/**
 * Canvas theme — the bridge between `styles.css` and the `<canvas>`.
 *
 * Nothing about a canvas inherits from CSS, so before this module the demo
 * carried two independent palettes: the custom properties in `styles.css` and
 * a set of literals in `timeline.ts`. They drifted the moment either changed.
 *
 * CSS is the single source of truth. This reads the `--canvas-*` tokens off the
 * document element once, and `Timeline` caches the result rather than calling
 * `getComputedStyle` inside the draw loop (which would thrash layout at 60fps).
 */

export type CanvasTheme = {
  /** Ground the canvas is cleared to; matches `--bg`. */
  ground: string;
  /** Octave guide lines and their labels. */
  guide: string;
  guideText: string;
  /** Beat/bar gridlines from the metronome clock, and the bar numbers. */
  barLine: string;
  barLineText: string;
  /** The right-edge playhead. */
  playhead: string;
  /** "waiting for audio" hint text. */
  hint: string;
  /** Attack caps and bend origin guides — a luminance accent, not a hue. */
  highlight: string;
  /** Backing plate behind note labels, and the label text itself. */
  plate: string;
  plateText: string;
  /** Font stack, so the canvas uses the same faces as the DOM. */
  fontMono: string;
  fontDisplay: string;
  /** Pitch-class hue ramp, constrained to the palette's arc. */
  hueBase: number;
  hueSpan: number;
  sat: number;
};

/**
 * Fallbacks matter: a missing custom property returns "" from
 * `getPropertyValue`, and assigning "" to `ctx.fillStyle` silently keeps the
 * previous colour. That produces a canvas that is subtly wrong rather than
 * obviously broken, which is far harder to notice.
 */
const FALLBACK: CanvasTheme = {
  ground: "#000000",
  guide: "rgba(138, 138, 138, 0.16)",
  guideText: "rgba(138, 138, 138, 0.5)",
  barLine: "rgba(0, 255, 255, 0.34)",
  barLineText: "rgba(0, 255, 255, 0.6)",
  playhead: "rgba(255, 0, 255, 0.85)",
  hint: "rgba(230, 230, 230, 0.45)",
  highlight: "rgba(255, 255, 255, 1)",
  plate: "rgba(0, 0, 0, 0.62)",
  plateText: "rgba(230, 230, 230, 1)",
  fontMono: '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  fontDisplay: '"VT323", "Share Tech Mono", ui-monospace, monospace',
  hueBase: 176,
  hueSpan: 156,
  sat: 96,
};

export function readTheme(el: Element = document.documentElement): CanvasTheme {
  const css = getComputedStyle(el);
  const str = (name: string, fallback: string): string =>
    css.getPropertyValue(name).trim() || fallback;
  const num = (name: string, fallback: number): number => {
    const parsed = Number.parseFloat(css.getPropertyValue(name));
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return {
    ground: str("--canvas-ground", FALLBACK.ground),
    guide: str("--canvas-guide", FALLBACK.guide),
    guideText: str("--canvas-guide-text", FALLBACK.guideText),
    barLine: str("--canvas-barline", FALLBACK.barLine),
    barLineText: str("--canvas-barline-text", FALLBACK.barLineText),
    playhead: str("--canvas-playhead", FALLBACK.playhead),
    hint: str("--canvas-hint", FALLBACK.hint),
    highlight: str("--canvas-highlight", FALLBACK.highlight),
    plate: str("--canvas-plate", FALLBACK.plate),
    plateText: str("--canvas-plate-text", FALLBACK.plateText),
    fontMono: str("--font-mono", FALLBACK.fontMono),
    fontDisplay: str("--font-display", FALLBACK.fontDisplay),
    hueBase: num("--canvas-hue-base", FALLBACK.hueBase),
    hueSpan: num("--canvas-hue-span", FALLBACK.hueSpan),
    sat: num("--canvas-sat", FALLBACK.sat),
  };
}

/**
 * Replace the alpha of an `rgba(...)` token so one CSS variable can serve a
 * family of opacities. Falls back to the input when it is not `rgba()`.
 */
export function withAlpha(colour: string, alpha: number): string {
  const m = /^rgba?\(([^)]+)\)$/i.exec(colour.trim());
  if (!m) return colour;
  const [r, g, b] = m[1]?.split(/[,\s/]+/).filter(Boolean) ?? [];
  if (r === undefined || g === undefined || b === undefined) return colour;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
