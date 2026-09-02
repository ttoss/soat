import Link from '@docusaurus/Link';
import shared from '@site/src/components/HomepageShared/styles.module.css';
import { NOT_FOR, USE_CASES } from '@site/src/data/agentInstructions';
import Heading from '@theme/Heading';
import clsx from 'clsx';
import type * as React from 'react';

import styles from './styles.module.css';

/**
 * The decision band: which jobs SOAT is the right tool for, and which it is
 * not. It renders the same `USE_CASES` / `NOT_FOR` data that `/agents.md` and
 * the llms.txt preamble render, so the guidance a reader sees and the guidance
 * an agent reads cannot drift apart.
 */
const HomepageWhenToUse = (): React.ReactNode => {
  return (
    <section className={clsx(shared.band, styles.section)}>
      <div className="container">
        <div className={shared.header}>
          <p className={shared.eyebrow}>When to use SOAT</p>
          <Heading as="h2" className={shared.title}>
            Reach for SOAT when the agent has to be trusted with something.
          </Heading>
          <p className={shared.lead}>
            A single model call needs no infrastructure. SOAT earns its place
            the moment an agent has to remember, retrieve, coordinate, stay
            inside its permissions, or account for what it did. These are the
            jobs it is built for, the same list an agent reads at{' '}
            <a href="/agents.md">/agents.md</a>, where each one names the call
            that does it.
          </p>
        </div>

        <div className={styles.layout}>
          <ol className={styles.ledger}>
            {USE_CASES.map((useCase, index) => {
              return (
                <li className={styles.row} key={useCase.job}>
                  <span className={styles.rowIndex}>
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div className={styles.rowBody}>
                    <Heading as="h3" className={styles.job}>
                      {useCase.job}
                    </Heading>
                    <p className={styles.how}>{useCase.description}</p>
                  </div>
                  <Link
                    className={styles.moduleLink}
                    to={useCase.moduleLink.href}
                  >
                    <span className={shared.mono}>
                      {useCase.moduleLink.label}
                    </span>
                    <span aria-hidden="true">→</span>
                  </Link>
                </li>
              );
            })}
          </ol>

          <aside className={styles.notFor}>
            <Heading as="h3" className={styles.notForTitle}>
              When not to use it
            </Heading>
            <ul className={styles.notForList}>
              {NOT_FOR.map((entry) => {
                return <li key={entry}>{entry}</li>;
              })}
            </ul>
          </aside>
        </div>
      </div>
    </section>
  );
};

export default HomepageWhenToUse;
