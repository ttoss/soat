---
name: soat-design
description: Use this skill to generate well-branded interfaces and assets for SOAT (open-source infrastructure for production-ready AI agents), either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping.
user-invocable: true
---

Read the README.md file within this skill, and explore the other available files.

If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets out and create static HTML files for the user to view. If working on production code, you can copy assets and read the rules here to become an expert in designing with this brand.

If the user invokes this skill without any other guidance, ask them what they want to build or design, ask some questions, and act as an expert designer who outputs HTML artifacts _or_ production code, depending on the need.

Key starting points:
- `styles.css` — link this one file to inherit all SOAT tokens (colors, type, spacing, effects). Dual-theme: default is light; add `data-theme="dark"` to `<html>` for the native dark environment.
- `tokens/` — the CSS custom properties to reference (`--color-primary`, `--surface-page`, `--font-display`, `--gradient-brand`, `--glow-cyan-md`, etc).
- `components/` — React primitives: Button, Badge, MethodBadge, Tag, Input, Switch, Card, CodeBlock.
- `guidelines/` — foundation specimen cards (color, type, spacing, brand).

> Code-only install: the `ui_kits/` (full-screen recreations) and `assets/` (Vector Galaxy logo, hero, architecture PNGs) from the original bundle are not included here to keep the repo light. Pull them from the source bundle or the SOAT repo (`packages/website/static/img/`) if you need imagery.

Brand essentials: dark-mode-first, luminous (cyan/violet glow on deep space backgrounds); Space Grotesk headings + Inter body + JetBrains Mono code; engineered, precise, confident voice; NO emojis.
