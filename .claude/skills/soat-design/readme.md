# SOAT Design System

**SOAT — open-source infrastructure for production-ready AI agents.**

SOAT is open-source infrastructure for building AI applications. One self-hostable Node.js server provides IAM, file and document storage with vector search, conversational memory, agent orchestration, multi-agent workflows, retrieval-augmented generation, declarative stack deployment, and a full Model Context Protocol (MCP) server — backed by PostgreSQL. Every operation is exposed through four equivalent surfaces — **REST, MCP, CLI, and TypeScript SDK** — so the same call runs the same way from a backend, Claude Desktop, a CI script, or a UI.

This design system translates SOAT's identity — *robust, precise infrastructure that powers intelligent applications* — into reusable tokens, components, and specimen cards.

---

## Sources

The tokens and components mirror the SOAT repository, which stays the source of truth:

- **GitHub:** [`ttoss/soat`](https://github.com/ttoss/soat) — the monorepo. Key inputs:
  - `packages/website/src/css/custom.css` — the live Docusaurus theme (Infima variable overrides, dual-theme).
  - `packages/website/src/pages/index.tsx` + `src/components/Homepage*/` — the marketing homepage.
  - `packages/website/docusaurus.config.ts` — navbar, footer, color mode config.
  - `packages/website/docs/**` — module documentation (real product copy).
  - `packages/website/static/img/brand/` — the SVG masters of the mark; `static/img/` — the favicon, avatar, social card and README diagram.
- **Live site:** https://soat.ttoss.dev
- **Docs:** https://soat.ttoss.dev/docs/introduction

> Readers with repo access can pull deeper context (OpenAPI specs under `packages/server/src/rest/openapi/v1`, the SDK, and the CLI) to build richer, more accurate product recreations.

---

## Content Fundamentals

SOAT's voice is **a systems engineer describing something powerful** — technical, confident, concise, forward-looking.

- **Person:** Addresses the developer directly as *you* ("You bring the product. SOAT handles the infrastructure layer."). Describes the product in the third person ("SOAT provides…", "SOAT stores, retrieves, and manages context…").
- **Tone:** Technical, not academic. Confident, not loud. State benefits plainly; respect developer attention.
  - **Do:** "SOAT provides IAM, document storage with vector search, agent orchestration, and MCP integration out of the box."
  - **Don't:** "We use super-cool futuristic tech so your bot remembers stuff."
- **Casing:** Sentence case for headings and body ("Deploy complete agent stacks from one template."). Product/brand name is **always all-caps SOAT**. CLI command is lowercase `soat`. Eyebrows and small section labels are UPPERCASE with wide tracking ("WHAT SOAT PROVIDES", "AGENT FORMATIONS").
- **Headlines** are short, declarative, and benefit-led — often a single sentence ending in a period: *"One backend. Four ways to call it."*, *"From zero to running agent in three commands."*, *"Stop rebuilding agent infrastructure."*
- **Vocabulary:** infrastructure layer, surfaces, orchestration, sessions, memory, knowledge, traces, formations, self-hosted, governance, observability. Numbers are concrete ("5047", "5 min", "three commands", "Apache 2.0 licensed").
- **No emojis.** Ever — in docs, headers, UI, or commits. They contradict the engineered, precise aesthetic.
- **Code-forward:** copy frequently sits beside a terminal block or an endpoint. Commands and identifiers are monospace.

---

## Visual Foundations

The system descends from the mark: **one process** — a core held between two brackets, `[•]`. Everything an agent needs runs inside one self-hosted Node.js process on PostgreSQL, and the mark, the diagrams and the imagery all draw that boundary. Visuals should feel like *plumbing for intelligence* — invisible yet indispensable.

### The mark

| Element | Role | Token |
|---|---|---|
| **Boundary** | the process: a pair of square brackets, one flat colour | `--process-boundary` (Core Cyan dark, Electric Blue light) |
| **Core** | the one thing it runs, centred | `--process-core` (Starlight White dark, Deep Space Grey light) |
| **Inlets** | the four callers (REST, MCP, CLI, SDK) entering the boundary | diagrams only, `--soat-violet` lines |
| **Strike** | a line through what you do not have to run | diagrams only, Core Cyan |

- **Masters** live in `packages/website/static/img/brand/`: `soat-wordmark-{dark,light,mono}.svg` (`S[•]AT`, outlined Space Grotesk 700 with the O replaced by the brackets and core; the brackets are punctuation, drawn lighter than the letters — 96 units against the 132-unit stem) and `soat-symbol-{dark,light,mono}.svg`, plus `favicon.svg` (a 16 px pixel-aligned cut that follows the colour scheme). Use a master; never retype the wordmark or redraw the symbol.
- **Wordmark first.** Headers and navbars show the wordmark alone; the symbol stands in only where the space is square (favicon, avatar, app icon, empty states).
- **Solid, never a gradient.** The boundary is one flat colour, and so is everything else the brand fills.
- **Never close the brackets into a box.** A closed rounded square with a centred dot reads as another company's camera glyph; the open sides are what make the mark SOAT's.
- **Clear space:** the bracket's arm length on every side of the symbol; the height of the O around the wordmark. **Minimum size:** wordmark 16 px tall, symbol 16 px (the favicon cut).
- **Rasters:** `static/img/soat-logo.png` is the 512 px avatar (symbol on Space Black) used as the MCP server icon and in JSON-LD; `soat-logo-no-bg.png` is the transparent symbol in Electric Blue; `favicon.ico` carries 16/32/48 px.
- **Diagrams extend the mark:** the process is drawn between brackets, a caller enters through an inlet, PostgreSQL sits outside it, and what SOAT replaces is struck. Draw them from real module names, ports and commands.

**Theme strategy — dual-theme by design.** SOAT does not invert; it *shifts the functional hue*. **Dark mode is the native environment** (deep space, luminous accents). Light mode is accessibility-first on white.

- **Color.**
  - **One brand hue:** Electric Blue `#1A73E8` in light, Core Cyan `#00E5FF` in dark — the mark, links, focus and the primary action.
  - **Deep Violet `#8E44AD`** is a diagram colour only: the inlet lines, one layer among others. Never a fill behind text, never a gradient stop (`tests/harness/brandPalette.test.mjs`).
  - Light: page `#FFFFFF`, surfaces Pale Cosmos `#F5F7FA`, text Deep Space Grey `#1A1F2C`, **functional primary = Electric Blue**.
  - Dark: page Space Black `#080C14`, surfaces Nebula Navy `#161B22` / code `#0D1117`, text Starlight White `#F0F8FF`, **functional primary = Core Cyan**.
  - **The 4.5:1 rule:** Core Cyan is *never functional text* in light mode — decorative glow only. Use Electric Blue for interactive UI on light.
  - Imagery is cool — cyan and blue over deep navy/black, violet only inside diagrams.
- **No gradients, no background glows.** Fills are flat and page and section backgrounds are flat Space Black or white. A dot grid is a pattern and may stay; a radial wash behind a section is not.
- **The action colour.** Primary buttons paint `--color-action` with `--text-on-action` and step to `--color-action-hover`. Light: `#1567D3` (the mark's blue a step darker) with white text, 5.37:1. Dark: Core Cyan with Space Black text, 12.7:1, because white on Core Cyan is 1.54:1.
- **Method badges** (API reference): white labels on the light fills, Space Black labels on the brighter dark fills (`--method-fg`); every pair clears 4.5:1.
- **Type.** Headings: **Space Grotesk** (700/600/500), letter-spacing `0.02–0.03em` — engineered, geometric. Body/UI: **Inter** (400/500/600). Code: **JetBrains Mono**. Body line-height is generous (1.7) for long-form docs.
- **Spacing.** 4px base grid. Section padding is generous (≈80px). The logo wants clear space — the UI follows suit: calm, structured, never cramped.
- **Corner radii.** Soft and engineered, not pill-round. `md` (8px) is the workhorse for buttons/cards/inputs; code blocks and admonitions use `lg` (12px); feature cards `xl` (16px); only avatars/status dots/pills are fully round.
- **Borders.** Hairline (1px). Light: `rgba(26,31,44,0.08)`. Dark: cyan-tinted `rgba(0,229,255,0.08–0.12)` — borders themselves carry a faint glow in dark.
- **Shadows & glow.** Light mode uses soft, low shadows. **Dark mode trades shadow for glow:** active/hover elements *emit light* via cyan `box-shadow`/`text-shadow` (`0 0 20px–30px rgba(0,229,255,.3–.5)`). This is the signature move.
- **Glassmorphism (HUD feel).** Navbars and floating panels use `backdrop-filter: blur(16px)` over low-opacity surfaces.
- **Hover states.** Primary buttons lift `translateY(-2px)` and intensify their glow; secondary buttons shift border/text to the primary hue; cards lift `-4px` and gain a cyan-edged glow. Nav links glow on hover in dark mode.
- **Press / active.** Color deepens (primary-active token); no aggressive shrink.
- **Animation.** Restrained and purposeful — fades and short translate-lifts (150–300ms), eased with `cubic-bezier(0.16,1,0.3,1)`. No bounces. Motion suggests *data flow and retrieval*.
  - **Continuous loops** belong to two places only: faint background marks (the symbol at scale, breathing slowly) and data-flow connectors (dashes moving along a line). Never on the mark in a header, on text, on controls or on content blocks.
  - Every continuous loop stops under `@media (prefers-reduced-motion: reduce)`, declared in the same stylesheet as the loop (`tests/harness/reducedMotion.test.mjs`).
- **Cards.** Surface fill + 1px border + soft shadow (light) / glow-on-hover (dark), `xl` radius. Glass variant for HUD panels. **No** colored left-border-accent cards.
- **App sidebar navigation — flat modules.** Modules render as a single **flat list** in the app sidebar — one row per module with its own stroke icon, no collapsible groups, no indentation. The active row carries a left accent border in `--color-primary` plus a low-opacity primary tint; hover applies a fainter tint. Do **not** nest modules under collapsible category headers or chevrons. (Project picker and the `Admin` section remain distinct blocks above/below the flat module list.)
- **Imagery — use:** diagrams of the process drawn from real product data (callers, modules, `:5047`, PostgreSQL), real terminal transcripts and real API calls, on dark clean space. **Avoid:** illustration clip-art of the category — brains, database cylinders, shields with keys, isometric cubes, circuit traces, glowing node constellations — bright stock photography, and bluish-purple "AI slop" gradients that aren't the brand's violet→cyan flow.

---

## Iconography

SOAT favors **thin, geometric, stroke-based icons** with no fills — matching the engineered aesthetic. The website's own surface icons (REST/MCP/CLI/SDK in `HomepageSurfaces`) are hand-built inline SVGs at `viewBox 0 0 48 48` with `currentColor` strokes of weight **2–2.5**, rounded caps/joins, and the occasional low-opacity accent dot.

- **System used here:** [**Lucide**](https://lucide.dev) (CDN), chosen because its thin, consistent ~2px geometric stroke style closely matches SOAT's custom SVGs. See `guidelines/brand-iconography.card.html`.
  - *Substitution flag:* SOAT does not ship a packaged icon font; the repo contains only a few bespoke inline SVGs. Lucide is a close-matching stand-in for general use. If SOAT later publishes an icon set, swap the CDN link.
- **Stroke icons render in `currentColor`** — they pick up `--color-primary` (Electric Blue in light, Core Cyan in dark) and glow in dark contexts.
- **No emoji** as icons, anywhere. No unicode-glyph icons. A few text glyphs appear only as inert affordances (e.g. `⌘K` in search, `✓` in checklists).
- The mark is not an icon: never put it in an icon slot, and never draw an icon from its boundary.

---

## Index / Manifest

**Root**
- `styles.css` — the global entry point (consumers link this). `@import` manifest only.
- `readme.md` — this guide.
- `SKILL.md` — Agent Skill front matter for use in Claude Code.

**`tokens/`** — CSS custom properties (all `@import`ed by `styles.css`)
- `fonts.css` — Space Grotesk / Inter / JetBrains Mono (Google Fonts CDN).
- `colors.css` — brand DNA, neutral ramps, dual-theme semantic aliases, the action colour.
- `typography.css` — families, weights, type scale, line-heights, tracking.
- `spacing.css` — 4px spacing scale + layout sizes.
- `effects.css` — radii, shadows, neon glows, glass blur, motion easings.
- `base.css` — element defaults that apply the tokens to raw HTML.

**`components/`** — reusable React primitives (namespace `SOATDesignSystem_…`)
- `core/` — `Button`, `Badge`, `MethodBadge`, `Tag`
- `forms/` — `Input`, `Switch`
- `surfaces/` — `Card`, `CodeBlock`
- `_ds_bundle.js` (skill root) — the primitives bundled for the specimen cards; generated by `pnpm run design-bundle`, never edited by hand.

**`guidelines/`** — foundation specimen cards (Design System tab): Colors, Type, Spacing, Brand.

**Imagery** lives in the repository, not in this skill: `packages/website/static/img/brand/` holds the SVG masters (see *The mark*); `packages/website/static/img/` holds `favicon.ico`, `soat-logo.png` (avatar), `soat-logo-no-bg.png` (transparent symbol), `social-card.png`, `soat-architecture.png` (README diagram) and `architecture.svg` (docs diagram).

---

## Notes & caveats

- **Fonts** load from the Google Fonts CDN (all three are Google Fonts). To self-host, replace the `@import` in `tokens/fonts.css` with `@font-face` rules pointing at local binaries.
- **Icons** use Lucide as a documented stand-in (see Iconography). Flag for the SOAT team if an official set exists.
