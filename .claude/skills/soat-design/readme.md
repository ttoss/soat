# SOAT Design System

**SOAT — Infrastructure for production-ready AI agents.**

SOAT is open-source infrastructure for building AI applications. One self-hostable Node.js server provides IAM, file and document storage with vector search, conversational memory, agent orchestration, multi-agent workflows, retrieval-augmented generation, declarative stack deployment, and a full Model Context Protocol (MCP) server — backed by PostgreSQL. Every operation is exposed through four equivalent surfaces — **REST, MCP, CLI, and TypeScript SDK** — so the same call runs the same way from a backend, Claude Desktop, a CI script, or a UI.

This design system translates SOAT's identity — *robust, precise infrastructure that powers intelligent applications* — into reusable tokens, components, and full-screen recreations.

---

## Sources

This system was built from the official SOAT repository. Explore these to extend or verify the work:

- **GitHub:** [`ttoss/soat`](https://github.com/ttoss/soat) — the monorepo. Key inputs:
  - `BRANDBOOK.md` — SOAT Brand System v1.1 (the canonical color, type, voice, and imagery spec).
  - `packages/website/src/css/custom.css` — the live Docusaurus theme (Infima variable overrides, dual-theme).
  - `packages/website/src/pages/index.tsx` + `index.module.css` — the marketing homepage.
  - `packages/website/docusaurus.config.ts` — navbar, footer, color mode config.
  - `packages/website/docs/**` — module documentation (real product copy).
  - `packages/website/static/img/` — logo, hero, and architecture imagery.
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
- **Vocabulary:** infrastructure layer, surfaces, orchestration, sessions, memory, knowledge, traces, formations, self-hosted, governance, observability. Numbers are concrete ("5047", "5 min", "three commands", "MIT licensed").
- **No emojis.** Ever — in docs, headers, UI, or commits. They contradict the engineered, precise aesthetic.
- **Code-forward:** copy frequently sits beside a terminal block or an endpoint. Commands and identifiers are monospace.

---

## Visual Foundations

The entire system descends from the **Vector Galaxy** logo: a swirling nebula of cyan and violet nodes connected by glowing paths, with a bright recall-core at center. Visuals should feel like *plumbing for intelligence* — invisible yet indispensable.

**Theme strategy — dual-theme by design.** SOAT does not invert; it *shifts the functional hue*. **Dark mode is the native environment** (deep space, luminous accents). Light mode is accessibility-first on white.

- **Color.**
  - Brand DNA (constant): Deep Violet `#8E44AD`, Core Cyan `#00E5FF`, Electric Blue `#1A73E8`.
  - Light: page `#FFFFFF`, surfaces Pale Cosmos `#F5F7FA`, text Deep Space Grey `#1A1F2C`, **functional primary = Electric Blue**.
  - Dark: page Space Black `#080C14`, surfaces Nebula Navy `#161B22` / code `#0D1117`, text Starlight White `#F0F8FF`, **functional primary = Core Cyan**.
  - **The 4.5:1 rule:** Core Cyan is *never functional text* in light mode — decorative glow only. Use Electric Blue for interactive UI on light.
  - Imagery is cool — cyan/violet over deep navy/black. Light mode prefers transparent/faded cosmic imagery so it feels embedded, not pasted on.
- **Gradients (Vector Galaxy flow):** light = Violet → Electric Blue; dark = Violet → Core Cyan. Used on primary buttons, hero headline text-clip, and switch on-states. Page backgrounds are never flat black — a subtle radial cosmic wash implies depth.
- **Type.** Headings: **Space Grotesk** (700/600/500), letter-spacing `0.02–0.03em` — engineered, geometric. Body/UI: **Inter** (400/500/600). Code: **JetBrains Mono**. Body line-height is generous (1.7) for long-form docs.
- **Spacing.** 4px base grid. Section padding is generous (≈80px). The logo wants clear space — the UI follows suit: calm, structured, never cramped.
- **Corner radii.** Soft and engineered, not pill-round. `md` (8px) is the workhorse for buttons/cards/inputs; code blocks and admonitions use `lg` (12px); feature cards `xl` (16px); only avatars/status dots/pills are fully round.
- **Borders.** Hairline (1px). Light: `rgba(26,31,44,0.08)`. Dark: cyan-tinted `rgba(0,229,255,0.08–0.12)` — borders themselves carry a faint glow in dark.
- **Shadows & glow.** Light mode uses soft, low shadows. **Dark mode trades shadow for glow:** active/hover elements *emit light* via cyan `box-shadow`/`text-shadow` (`0 0 20px–30px rgba(0,229,255,.3–.5)`). This is the signature move.
- **Glassmorphism (HUD feel).** Navbars and floating panels use `backdrop-filter: blur(16px)` over low-opacity surfaces.
- **Hover states.** Primary buttons lift `translateY(-2px)` and intensify their glow; secondary buttons shift border/text to the primary hue; cards lift `-4px` and gain a cyan-edged glow. Nav links glow on hover in dark mode.
- **Press / active.** Color deepens (primary-active token); no aggressive shrink.
- **Animation.** Restrained and purposeful — fades and short translate-lifts (150–300ms), eased with `cubic-bezier(0.16,1,0.3,1)`. No bounces, no infinite decorative loops on content. Motion suggests *data flow and retrieval*.
- **Cards.** Surface fill + 1px border + soft shadow (light) / glow-on-hover (dark), `xl` radius. Glass variant for HUD panels. **No** colored left-border-accent cards.
- **Imagery — use:** node-and-connection constellations, light trails, dark clean space, abstract geometry (hexagons, spheres, spirals of light). **Avoid:** literal brain icons, classic database cylinders, bright sunny stock photography, and bluish-purple "AI slop" gradients that aren't the brand's violet→cyan flow.

---

## Iconography

SOAT favors **thin, geometric, stroke-based icons** with no fills — matching the engineered aesthetic. The website's own surface icons (REST/MCP/CLI/SDK in `HomepageSurfaces`) are hand-built inline SVGs at `viewBox 0 0 48 48` with `currentColor` strokes of weight **2–2.5**, rounded caps/joins, and the occasional low-opacity accent dot.

- **System used here:** [**Lucide**](https://lucide.dev) (CDN), chosen because its thin, consistent ~2px geometric stroke style closely matches SOAT's custom SVGs. See `guidelines/brand-iconography.card.html`.
  - *Substitution flag:* SOAT does not ship a packaged icon font; the repo contains only a few bespoke inline SVGs. Lucide is a close-matching stand-in for general use. If SOAT later publishes an icon set, swap the CDN link.
- **Stroke icons render in `currentColor`** — they pick up `--color-primary` (Electric Blue in light, Core Cyan in dark) and glow in dark contexts.
- **No emoji** as icons, anywhere. No unicode-glyph icons. A few text glyphs appear only as inert affordances (e.g. `⌘K` in search, `✓` in checklists).
- Logo and imagery (galaxy, hero, architecture) are raster PNGs in `assets/`. Never redraw the Vector Galaxy as SVG — use the supplied asset.

---

## Index / Manifest

**Root**
- `styles.css` — the global entry point (consumers link this). `@import` manifest only.
- `readme.md` — this guide.
- `SKILL.md` — Agent Skill front matter for use in Claude Code.

**`tokens/`** — CSS custom properties (all `@import`ed by `styles.css`)
- `fonts.css` — Space Grotesk / Inter / JetBrains Mono (Google Fonts CDN).
- `colors.css` — brand DNA, neutral ramps, dual-theme semantic aliases, gradients.
- `typography.css` — families, weights, type scale, line-heights, tracking.
- `spacing.css` — 4px spacing scale + layout sizes.
- `effects.css` — radii, shadows, neon glows, glass blur, motion easings.
- `base.css` — element defaults that apply the tokens to raw HTML.

**`components/`** — reusable React primitives (namespace `SOATDesignSystem_…`)
- `core/` — `Button`, `Badge`, `MethodBadge`, `Tag`
- `forms/` — `Input`, `Switch`
- `surfaces/` — `Card`, `CodeBlock`

**`guidelines/`** — foundation specimen cards (Design System tab): Colors, Type, Spacing, Brand.

**`ui_kits/`** — full-screen product recreations
- `website/` — the marketing homepage (theme-toggleable).
- `docs/` — the documentation site (sidebar-navigable, API reference).

**`assets/`** — `soat-logo.png` (transparent Vector Galaxy), `soat-logo-dark-bg.png`, `hero.png`, `architecture.png`, `social-card.png`.

---

## Notes & caveats

- **Fonts** load from the Google Fonts CDN (all three are Google Fonts). To self-host, replace the `@import` in `tokens/fonts.css` with `@font-face` rules pointing at local binaries.
- **Icons** use Lucide as a documented stand-in (see Iconography). Flag for the SOAT team if an official set exists.
- UI kits are cosmetic recreations for design work — not production code. They compose the real token system and primitives but stub data and navigation.
