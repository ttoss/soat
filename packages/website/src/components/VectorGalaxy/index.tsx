import clsx from 'clsx';
import type * as React from 'react';

import styles from './styles.module.css';

const BITMAP = '/img/soat-logo-no-bg.png';

/**
 * The Vector Galaxy logo, turning in its own tilted plane. The bitmap is drawn
 * twice: the arms rotate with the core masked out, and the core with its
 * horizontal flare stays still under the complementary mask, so at rest the two
 * layers add up to the bitmap itself. Size it by width, or by height with
 * `width: auto`.
 */
const VectorGalaxy = (props: {
  className?: string;
  alt?: string;
  loading?: 'lazy' | 'eager';
}): React.ReactNode => {
  return (
    <span className={clsx(styles.galaxy, props.className)}>
      <img
        className={styles.arms}
        src={BITMAP}
        alt=""
        loading={props.loading}
      />
      <img
        className={styles.core}
        src={BITMAP}
        alt={props.alt ?? ''}
        loading={props.loading}
      />
    </span>
  );
};

export default VectorGalaxy;
