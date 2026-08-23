import { ONBOARDING_STEPS } from '@site/src/data/agentInstructions';
import Heading from '@theme/Heading';
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
    <section className={styles.section}>
      <div className="container">
        <div className={styles.header}>
          <p className={styles.eyebrow}>Getting access</p>
          <Heading as="h2">
            No signup, no sales call, no waitlist — self-serve from the first
            command.
          </Heading>
          <p>
            SOAT is Apache-2.0 software you run yourself, so there is nothing to
            request and no tier to be approved for. A local deployment is the
            same software as a production one: the sandbox, the free tier, and
            the product are one thing. Keys are minted by an API call, which
            matters because an agent cannot fill in a contact form.
          </p>
        </div>
        <div className={styles.steps}>
          {ONBOARDING_STEPS.map((step, index) => {
            return (
              <div className={styles.step} key={step.step}>
                <span className={styles.stepNumber}>
                  {String(index + 1).padStart(2, '0')}
                </span>
                <Heading as="h3">{step.step}</Heading>
                <p>{step.detail.replace(/`/g, '')}</p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default HomepageOnboarding;
