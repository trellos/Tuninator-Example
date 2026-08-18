#!/usr/bin/env node
/**
 * contrast-audit — WCAG contrast for a stylesheet's CSS custom properties.
 *
 *   node contrast-audit.mjs <stylesheet.css> [--ground --bg] [--min 4.5] [--json]
 *
 * Parses `--name: <colour>` declarations out of a CSS file, resolves one-level
 * `var()` aliases, and reports every colour token's contrast against the ground.
 *
 * Why this exists: neon-on-black *feels* high-contrast, and mostly is — but the
 * magenta/orange/violet end of the palette lands in the 5-7:1 band, which is
 * fine for body text and wrong for 10px labels. That distinction is invisible
 * by eye on a glowing dark UI, so it needs measuring.
 *
 * Exits 1 if any token tagged as text-bearing falls below --min.
 */

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const MIN = Number(flag("min", "4.5"));
const GROUND = flag("ground", "--bg");
const JSON_OUT = args.includes("--json");

if (!file) {
  console.error("usage: contrast-audit.mjs <stylesheet.css> [--ground --bg] [--min 4.5] [--json]");
  process.exit(2);
}

/* ---------- colour parsing ---------- */

const NAMED = { black: "#000000", white: "#ffffff", transparent: null };

function parseColour(raw) {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (s in NAMED) return NAMED[s];

  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length === 8) h = h.slice(0, 6); // drop alpha; we report opaque contrast
    if (h.length !== 6) return null;
    return `#${h}`;
  }

  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).slice(0, 3).map(Number);
    if (p.length < 3 || p.some(Number.isNaN)) return null;
    return "#" + p.map((n) => Math.round(n).toString(16).padStart(2, "0")).join("");
  }
  return null; // color-mix(), hsl(), gradients: not statically resolvable
}

function relLuminance(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function ratio(a, b) {
  const [x, y] = [relLuminance(a), relLuminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/* ---------- extract tokens ---------- */

const css = readFileSync(file, "utf8");
const decls = new Map();
for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) {
  if (!decls.has(m[1])) decls.set(m[1], m[2].trim()); // first wins (:root before overrides)
}

// resolve simple `var(--other)` aliases, a couple of levels deep
function resolve(name, depth = 0) {
  const raw = decls.get(name);
  if (!raw || depth > 4) return null;
  const alias = /^var\(\s*(--[\w-]+)/.exec(raw);
  if (alias) return resolve(alias[1], depth + 1);
  return parseColour(raw);
}

const ground = resolve(GROUND);
if (!ground) {
  console.error(`could not resolve ground colour ${GROUND} in ${file}`);
  process.exit(2);
}

/* Tokens whose job is to carry text. Everything else is graphics: WCAG 1.4.11
 * wants 3:1 for those, and decorative lines have no floor at all. */
const TEXT_HINT = /(^--text|text$|^--fg|foreground)/;
/* Surfaces are the thing other colours are measured *against*, so measuring
 * them against the ground is meaningless (a ground is 1:1 with itself). Names
 * like `--canvas-ground` and `--card-plate` are backgrounds even though they
 * do not start with `--bg`. */
const SKIP_HINT =
  /(^--bg|^--border|^--line|^--grid|^--scanline|^--shadow|^--glow|^--focus|ground$|plate$|surface$|backdrop$|^--canvas-ground|^--canvas-plate$)/;

const rows = [];
for (const [name] of decls) {
  if (SKIP_HINT.test(name)) continue;
  const hex = resolve(name);
  if (!hex) continue;
  const r = ratio(hex, ground);
  const isText = TEXT_HINT.test(name);
  rows.push({
    token: name,
    hex,
    ratio: Math.round(r * 100) / 100,
    tier: r >= 7 ? "AAA" : r >= 4.5 ? "AA" : r >= 3 ? "graphics-only" : "fail",
    textBearing: isText,
    ok: isText ? r >= MIN : r >= 3,
  });
}

rows.sort((a, b) => a.ratio - b.ratio);
const failures = rows.filter((r) => !r.ok);

if (JSON_OUT) {
  console.log(JSON.stringify({ file, ground, min: MIN, rows, failures }, null, 2));
} else {
  console.log(`\ncontrast against ${GROUND} = ${ground}   (text floor ${MIN}:1, graphics floor 3:1)\n`);
  const w = Math.max(...rows.map((r) => r.token.length), 5);
  for (const r of rows) {
    const mark = r.ok ? "ok  " : "FAIL";
    const kind = r.textBearing ? "text" : "gfx ";
    console.log(
      `  ${mark}  ${r.token.padEnd(w)}  ${r.hex}  ${String(r.ratio).padStart(6)}:1  ${kind}  ${r.tier}`
    );
  }
  console.log(
    `\n  ${rows.length} tokens · ${failures.length} failing` +
      (failures.length ? `: ${failures.map((f) => f.token).join(", ")}` : "") +
      "\n"
  );
  console.log("  Tokens using color-mix()/hsl() are skipped — they can't be resolved statically.\n");
}

process.exit(failures.length ? 1 : 0);
