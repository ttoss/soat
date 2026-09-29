import symbolDark from '@/assets/brand/soat-symbol-dark.svg';
import symbolLight from '@/assets/brand/soat-symbol-light.svg';
import wordmarkDark from '@/assets/brand/soat-wordmark-dark.svg';
import wordmarkLight from '@/assets/brand/soat-wordmark-light.svg';

// Bundled with the console rather than fetched from the website, so offline
// installs keep the mark. The files mirror the masters in
// `packages/website/static/img/brand/` byte for byte
// (`tests/harness/appBrandAssets.test.mjs`).
export const BRAND_ASSETS = {
  /** The S[•]AT wordmark: the O is the core held between two brackets. */
  wordmark: { light: wordmarkLight, dark: wordmarkDark },
  /** The [•] symbol, for square placements. */
  symbol: { light: symbolLight, dark: symbolDark },
} as const;
