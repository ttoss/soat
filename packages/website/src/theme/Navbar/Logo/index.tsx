import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import ThemedImage from '@theme/ThemedImage';
import type * as React from 'react';

import styles from './styles.module.css';

/**
 * The navbar brand: the S[•]AT wordmark from the brand masters, in the variant
 * for the active colour mode. It keeps the class the stock component renders,
 * so the theme's navbar layout applies.
 */
const NavbarLogo = (): React.ReactNode => {
  return (
    <Link to="/" className="navbar__brand">
      <ThemedImage
        className={styles.wordmark}
        alt="SOAT"
        sources={{
          light: useBaseUrl('/img/brand/soat-wordmark-light.svg'),
          dark: useBaseUrl('/img/brand/soat-wordmark-dark.svg'),
        }}
      />
    </Link>
  );
};

export default NavbarLogo;
