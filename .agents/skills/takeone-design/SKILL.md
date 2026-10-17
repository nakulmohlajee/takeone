---
name: takeone-design
description: >-
  Orchestrates TakeOne UI/marketing design work using Emil Kowalski design-eng,
  Impeccable, Taste (design-taste-frontend), and redesign-existing-projects,
  then verifies with Playwright screenshots. Use when improving TakeOne visuals,
  marketing pages, product chrome, spacing, typography, motion, or when the user
  asks for a premium redesign, design critique, or before/after screenshots.
---

# TakeOne design workflow

Use this skill whenever the user wants TakeOne to look less generic and more
studio-grade. Do not invent a bland template look. Pull decisions from the
installed design skills and verify in a real browser.

## Skills to read first (in order)

1. `.agents/skills/design-taste-frontend/SKILL.md` — for marketing / landing /
   public pages. Deal directions; pick one; enforce no-slop house style.
2. `.agents/skills/redesign-existing-projects/SKILL.md` — for existing product
   screens (script overview, shooting, director's cut). Preserve flows; upgrade
   composition, type, spacing, motion.
3. `.agents/skills/emil-design-eng/SKILL.md` — layout, typography, spacing,
   animation craft.
4. `.agents/skills/impeccable/SKILL.md` — polish passes (critique, distill,
   typeset, quieter/bolder as needed).

Taste is for public-facing pages. For in-app screens, lead with
`redesign-existing-projects` + Emil + Impeccable.

## Product constraints (do not violate)

- TakeOne is an AI director for everyone: script → shoot with teleprompter →
  cleanup / captions / b-roll / virtual background.
- Prefer the existing React + Tailwind stack. Do not introduce a new design
  system library unless the user asks.
- Respect the user's frontend design rules already in the project (brand-first
  heroes, no card clutter, no purple-on-white AI defaults, expressive type,
  real visual anchors).
- Keep Cloud Run / cost constraints out of the visual redesign unless the
  change adds heavy client assets that break capture performance.

## Creative-director brief template

Before building, fill this (ask the user only for missing pieces):

```
Surface: [marketing home | script overview | guided shoot | director's cut]
Audience: [creators / students / hackathon judges / …]
Feeling: [e.g. clean, premium, trustworthy, cinematic]
References: [1–2 real sites]
Brand: colors [hex], fonts [names] (or keep current TakeOne tokens)
Job of this screen: [one sentence]
Pages (marketing): [home, services/features, about, contact]
Home sections: hero with ONE clear promise · 3 benefits · proof · FAQ · one CTA
Success: Playwright desktop + mobile screenshots look intentional; no overflow;
spacing consistent; one clear CTA / primary action.
```

## Execution loop

1. **Orient** — screenshot the current UI (`npm run design:shots -- --label before`).
2. **Direct** — read Taste / redesign skill; choose a direction; note type,
   palette, section composition. Do not skip references.
3. **Build** — implement the change in the real components. Prefer one
   composition per viewport; tighten spacing with exact numbers.
4. **Verify** — with the app running (`npm run dev`):
   ```bash
   npm run design:shots -- --label after --paths /
   # or for a specific route once routing/query is known:
   npm run design:shots -- --label after --paths /
   npx playwright test --project=desktop --project=mobile
   ```
5. **Critique** — open the PNGs in `design-shots/` at desktop (1440px) and
   mobile (390px). Fix spacing, overflow, alignment, weak brand hierarchy
   *before* showing the user anything. Then show before/after screenshots.
6. **Refine** — first pass is ~80%. The second pass is specifics, not vibes:
   - one spacing scale for sections (e.g. 96px desktop / 64px mobile)
   - hero: more whitespace, larger headline, one primary button (not two)
   - no horizontal scroll at 390px; nav fits or collapses
   Re-screenshot after every pass.

## Playwright commands

```bash
# App must be running on DESIGN_BASE_URL (default http://127.0.0.1:3000)
npm run design:shots
npm run design:shots -- --label before
npm run design:shots -- --label after --paths /
npm run design:test
```

Screenshots land in `design-shots/<label>/`. Always inspect the images (Read
tool) before claiming the design is done.

## When it still looks generic

- **Still looks like AI** → Taste was skipped or no reference given. Re-run
  Taste, pick a stronger reference; do not restyle in place.
- **Cramped / misaligned** → exact spacing numbers, fully responsive, then
  re-check mobile overflow with Playwright.
- **Images look fake** → generate real custom images (or real product /
  capture frames) and rebuild the composition around them.
- **Fonts render wrong live** → wire web fonts for production, not just the
  dev preview: correct Google Fonts `<link>` (or self-hosted files),
  `font-display: swap`, preload the primary weight, and check the deployed
  build, not only `npm run dev`.

Rule of thumb: taste comes from the skills and the references, not from asking
nicely.

## Figma

If a Figma MCP is connected, use it for structure and token pull. If not,
proceed from references + screenshots; do not block on Figma.
