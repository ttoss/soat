import * as path from 'node:path';

import { metadataViolations, readBuiltPages } from './seoMetadata';

/**
 * Post-build gate: every page in `build/` carries a title and a meta
 * description inside the bounds of `seoMetadata.ts`, and no two pages share
 * either. A violation fails the build.
 */
const main = () => {
  const buildDir = path.resolve(__dirname, '../build');
  const pages = readBuiltPages({ buildDir });
  const violations = metadataViolations({ pages });

  if (violations.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `SEO metadata: ${violations.length} problem(s) across ${pages.length} pages:\n${violations.join('\n')}`
    );
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(`SEO metadata: ${pages.length} pages checked.`);
};

main();
