import Link from '@docusaurus/Link';
import PrimaryAction from '@site/src/components/HomepageShared/PrimaryAction';
import shared from '@site/src/components/HomepageShared/styles.module.css';
import Heading from '@theme/Heading';
import clsx from 'clsx';
import type * as React from 'react';

import styles from './styles.module.css';

const HomepageFinalCta = (): React.ReactNode => {
  return (
    <section className={clsx(shared.bleed, shared.dark, styles.section)}>
      <div className={clsx('container', styles.inner)}>
        <Heading as="h2" className={styles.title}>
          Stop rebuilding agent infrastructure.
        </Heading>
        <p className={styles.lead}>
          Self-host SOAT and ship agents that can reach what they need, prove
          they did the job, and improve on evidence.
        </p>
        <div className={styles.actions}>
          <PrimaryAction />
          <Link className={shared.ghostButton} to="/docs/introduction">
            Read the docs
          </Link>
        </div>
      </div>
    </section>
  );
};

export default HomepageFinalCta;
