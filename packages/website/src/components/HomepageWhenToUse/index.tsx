import { NOT_FOR, USE_CASES } from '@site/src/data/agentInstructions';
import CodeBlock from '@theme/CodeBlock';
import Heading from '@theme/Heading';
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
    <section className={styles.section}>
      <div className="container">
        <div className={styles.header}>
          <p className={styles.eyebrow}>When to use SOAT</p>
          <Heading as="h2">
            Reach for SOAT when the agent has to be trusted with something.
          </Heading>
          <p>
            A single model call needs no infrastructure. SOAT earns its place
            the moment an agent has to remember, retrieve, coordinate, stay
            inside its permissions, or account for what it did. These are the
            jobs it is built for — the same list an agent reads at{' '}
            <a href="/agents.md">/agents.md</a>, where each one names the call
            that does it.
          </p>
        </div>
        <div className={styles.list}>
          {USE_CASES.map((useCase) => {
            return (
              <div className={styles.card} key={useCase.job}>
                <Heading as="h3">{useCase.job}</Heading>
                <p>{useCase.description}</p>
                {useCase.cli ? (
                  <div className={styles.command}>
                    <CodeBlock language="bash">
                      {useCase.cli.join('\n')}
                    </CodeBlock>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <div className={styles.notFor}>
          <Heading as="h3">When not to use it</Heading>
          <ul>
            {NOT_FOR.map((entry) => {
              return <li key={entry}>{entry}</li>;
            })}
          </ul>
        </div>
      </div>
    </section>
  );
};

export default HomepageWhenToUse;
