import Link from '@docusaurus/Link';
import shared from '@site/src/components/HomepageShared/styles.module.css';
import Heading from '@theme/Heading';
import clsx from 'clsx';
import type * as React from 'react';

import styles from './styles.module.css';

const HomepageFinalCta = (): React.ReactNode => {
  return (
    <section className={clsx(shared.bleed, shared.dark, styles.section)}>
      <div className={styles.galaxy} aria-hidden="true">
        <img src="/img/soat-logo-no-bg.png" alt="" loading="lazy" />
      </div>
      <div className={clsx('container', styles.inner)}>
        <Heading as="h2" className={styles.title}>
          Stop rebuilding agent infrastructure.
        </Heading>
        <p className={styles.lead}>
          Self-host SOAT and ship agents that can reach what they need, prove
          they did the job, and improve on evidence. Sessions, knowledge,
          memory, IAM, guardrails, versions, traces and MCP, on your own
          infrastructure.
        </p>
        <div className={styles.actions}>
          <Link
            className="button button--primary button--lg"
            to="/docs/getting-started"
          >
            Run it locally
          </Link>
          <Link className={shared.ghostButton} to="/docs/introduction">
            Read the docs
          </Link>
        </div>
        <p className={styles.note}>
          Weighing your options?{' '}
          <Link to="/benchmark">
            See how SOAT compares to other agent solutions
          </Link>
          .
        </p>
      </div>
    </section>
  );
};

export default HomepageFinalCta;
