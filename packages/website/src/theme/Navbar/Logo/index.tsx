import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import VectorGalaxy from '@site/src/components/VectorGalaxy';
import type * as React from 'react';

import styles from './styles.module.css';

/**
 * The navbar brand with the animated Vector Galaxy. It keeps the classes the
 * stock component renders, so the theme's navbar layout and truncation apply.
 */
const NavbarLogo = (): React.ReactNode => {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Link to="/" className="navbar__brand">
      <span className="navbar__logo">
        <VectorGalaxy className={styles.galaxy} loading="eager" />
      </span>
      <b className="navbar__title text--truncate">{siteConfig.title}</b>
    </Link>
  );
};

export default NavbarLogo;
