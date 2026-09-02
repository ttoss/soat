import Link from '@docusaurus/Link';
import shared from '@site/src/components/HomepageShared/styles.module.css';
import { ONBOARDING_STEPS } from '@site/src/data/agentInstructions';
import Heading from '@theme/Heading';
import clsx from 'clsx';
import type * as React from 'react';

import styles from './styles.module.css';

/**
 * The onboarding band. It exists because "no free tier, self-serve keys, or
 * sandbox detected" is a conclusion a reader — or a crawler — can reach from a
 * page that never says otherwise, even when the software is Apache-2.0 and
 * needs no signup at all. Same `ONBOARDING_STEPS` data as `/agents.md`.
 */
const HomepageOnboarding = (): React.ReactNode => {
  return (
    <section
      className={clsx(shared.band, shared.bleed, shared.dark, styles.section)}
    >
      <div className="container">
        <div className={styles.layout}>
          <div className={styles.copy}>
            <p className={shared.eyebrow}>Getting access</p>
            <Heading as="h2" className={shared.title}>
              No signup. No sales call. No waitlist.
            </Heading>
            <p className={shared.lead}>
              SOAT is Apache-2.0 software you run yourself, so there is nothing
              to request and no tier to be approved for. A local deployment is
              the same software as a production one: the sandbox, the free tier
              and the product are one thing. Keys are minted by an API call,
              which matters because an agent cannot fill in a contact form.
            </p>
            <Link
              className={clsx(shared.ghostButton, styles.cta)}
              to="/docs/getting-started"
            >
              Open the quick start
            </Link>
          </div>

          <ol className={styles.rail}>
            {ONBOARDING_STEPS.map((step, index) => {
              return (
                <li className={styles.checkpoint} key={step.step}>
                  <span className={styles.node} aria-hidden="true">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div className={styles.checkpointBody}>
                    <Heading as="h3" className={styles.checkpointTitle}>
                      {step.step}
                    </Heading>
                    <p className={styles.checkpointDetail}>
                      {step.detail.replace(/`/g, '')}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </section>
  );
};

export default HomepageOnboarding;
