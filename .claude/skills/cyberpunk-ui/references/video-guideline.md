# Source guideline (verbatim)

Transcribed from **"The ONLY Guide to Cyberpunk UI Design"**
<https://www.youtube.com/watch?v=yLdJh2_-o8U> (published 2024-09-17, runtime 4:30).

Slide text below is quoted verbatim. Timestamps point at the frame the text is taken from.
When this file and the rest of the skill disagree, **this file wins** — the rest is interpretation.

---

## Framing (0:00 – 1:05)

The video opens on 1990s CD-ROM and early-web material — *Burn:Cycle*, *CyberTown*,
*Computer Boulevard*, Neuromancer-era game UIs — then puts up a two-column comparison:

> **cyberpunk then:**  ·  **cyberpunk now:**

"then" is the low-fi, dense, wireframe-and-grid material above. "now" is the modern synthwave
cliché: a neon-lit purple city, a chrome-and-magenta portrait. The video sides with **then**.
Contemporary sites shown as living examples: `n-o-d-e.net`, `neondystopia.com`.

At 1:05 it states the goal:

> **GOAL:** create a guideline for cyberpunk web design

That framing matters as much as the rules. This is a **retro-dystopian** brief, not a
neon-gradient brief. When a choice is available, take the one that looks like a 1997 terminal
rather than a 2019 album cover.

---

## 1. COLOR PALETTE (1:20 – 2:05)

> Cyberpunk visuals are dominated by neon colors combined with dark backgrounds

> - Neon Greens & Blues
> - Bright Purples & Pinks
> - Fluorescent Yellows & Reds
> - Black/Very Dark Backgrounds
>
> - Primary Colors:   `#00FF00`   `#00FFFF`   `#FF00FF`
> - Secondary Colors: `#FFD700`   `#FF4500`
> - Background:       `#000000`

---

## 2. TYPOGRAPHY (2:10 – 2:40)

> The fonts used in cyberpunk UIs are typically blocky, tech-like, or pixelated to mimic
> futuristic interfaces or retro-futuristic aesthetics.

> - Glowing effect
> - Fonts: Roboto Mono, VT323, or custom pixel art fonts

---

## 3. VISUAL ELEMENTS (2:45 – 3:20)

> Key UI elements include grids, modular designs, and wireframes.

> - Grids and Geometric Patterns
> - Hexagonal and Circular Shapes
> - Glitch Effects

---

## 4. INTERFACE NAVIGATION (3:25 – 3:48)

> The UI design should guide users like a futuristic "control panel," with clearly defined
> sections and intuitive navigation.

> - Buttons with Techy Aesthetics
> - Navigation Panel

---

## 5. INTERACTIVITY (3:50 – 4:12)

> Hover and focus effects to make the user feel like they are interacting with an advanced system.

> - Hover Effects
> - Progressive Disclosure

---

## Closing (4:25)

The video ends on a joke: an ornate Victorian cartouche reading *"Website Title Here:"* — the
anti-cyberpunk, held up as what not to do.

---

## What the video does NOT say

Worth stating plainly, because these are the things most "cyberpunk CSS" posts add and then
attribute to the genre:

- **Scanlines, CRT curvature, grain, chromatic aberration and flicker are never named as rules.**
  They fit the retro-dystopian framing and this skill offers them as optional texture, but they are
  extension, not spec. Rule 3 names glitch — it does not name scanlines.
- No spacing scale, type scale, grid dimensions or motion timings are given.
- No accessibility guidance is given. The guardrails in `SKILL.md` are this skill's additions.

## What the video's own slides demonstrate

The slides are themselves a worked example, and they are more restrained than the bullet list
sounds. Worth copying:

- Body copy is **plain white monospace on near-black** — no glow, no neon, no glitch.
- Only the section heading glows, and each heading is colored from the palette it is teaching:
  COLOR PALETTE is green, TYPOGRAPHY cyan, VISUAL ELEMENTS magenta, INTERFACE NAVIGATION gold,
  INTERACTIVITY orange-red — the five palette entries, one per section.
- Headings carry a horizontal RGB-split/glitch distortion; the body text carries none.

That ratio — one glowing neon element against a page of quiet monospace — is the whole trick.
