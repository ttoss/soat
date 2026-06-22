// SOAT brand imagery, served from the website's static assets
// (packages/website/static/img). The Vector Galaxy mark is transparent and
// dark-mode-first; per the soat-design brand rules it emits its own light, so
// render it with clear space and no drop shadow, and never invert or stretch it.
const WEBSITE_BASE = 'https://soat.ttoss.dev';

export const BRAND_ASSETS = {
  /** Transparent Vector Galaxy mark (no background) — the primary logo. */
  logoMark: `${WEBSITE_BASE}/img/soat-logo-no-bg.png`,
  /** Vector Galaxy logo on its own backdrop. */
  logoFull: `${WEBSITE_BASE}/img/soat-logo.png`,
  /** Marketing hero render. */
  hero: `${WEBSITE_BASE}/img/hero.png`,
  /** Architecture diagram. */
  architecture: `${WEBSITE_BASE}/img/soat-architecture.png`,
} as const;
