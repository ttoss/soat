import logoMark from '@/assets/soat-logo-no-bg.png';

// Bundled with the console rather than fetched from the website, so offline
// installs keep the mark (`tests/harness/appBrandAssets.test.mjs`). The Vector
// Galaxy mark is transparent and dark-mode-first: per the brand rules it emits
// its own light, so give it clear space, no drop shadow, and never invert or
// stretch it.
export const BRAND_ASSETS = {
  /** Transparent Vector Galaxy mark (no background) — the primary logo. */
  logoMark,
} as const;
