import { QUICKSTART_COMMANDS } from '@site/src/data/homepage';
import clsx from 'clsx';
import type * as React from 'react';

import styles from './styles.module.css';

/**
 * The four CLI calls from an empty project to an agent's reply. A terminal is
 * dark in both color modes, so its palette is fixed rather than themed.
 */
const HomepageTerminal = (props: { className?: string }): React.ReactNode => {
  return (
    <figure className={clsx(styles.terminal, props.className)}>
      <div className={styles.titleBar}>
        <span className={styles.titleTab}>soat · bash</span>
        <span className={styles.titleStatus}>exit 0</span>
      </div>
      <pre className={styles.screen}>
        {QUICKSTART_COMMANDS.map((step, index) => {
          return (
            <code key={step.title} className={styles.block}>
              <span className={styles.line}>
                <span className={styles.comment}>
                  # {index + 1}. {step.title.toLowerCase()}
                </span>
              </span>
              {step.lines.map((line, lineIndex) => {
                return (
                  <span className={styles.line} key={line}>
                    <span className={styles.prompt} aria-hidden="true">
                      {lineIndex === 0 ? '$' : ' '}
                    </span>
                    <span
                      className={lineIndex === 0 ? styles.command : styles.arg}
                    >
                      {line}
                    </span>
                  </span>
                );
              })}
            </code>
          );
        })}
        <code className={styles.output}>
          <span className={styles.line}>
            <span className={styles.comment}>
              # the reply, plus a trace_id recording every tool call and token
            </span>
          </span>
        </code>
      </pre>
      <figcaption className={styles.caption}>
        The CLI is the whole API as sub-commands, so the path to a working agent
        is also a script you can commit.
      </figcaption>
    </figure>
  );
};

export default HomepageTerminal;
