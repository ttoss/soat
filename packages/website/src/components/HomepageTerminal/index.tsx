import Link from '@docusaurus/Link';
import shared from '@site/src/components/HomepageShared/styles.module.css';
import Heading from '@theme/Heading';
import clsx from 'clsx';
import * as React from 'react';

import styles from './styles.module.css';

type Step = {
  title: string;
  note: string;
  lines: string[];
};

const STEPS: Step[] = [
  {
    title: 'Create the agent',
    note: 'Bind it to any configured provider. The configuration is archived as an append-only version from the first write.',
    lines: [
      'soat create-agent \\',
      '  --project-id "$PROJECT_ID" \\',
      '  --ai-provider-id "$PROVIDER_ID" \\',
      '  --name support-bot \\',
      '  --instructions "You are a helpful support assistant."',
    ],
  },
  {
    title: 'Open a session',
    note: 'One user, one agent. Message history lives in PostgreSQL, so it survives the process.',
    lines: [
      'soat create-session \\',
      '  --agent-id "$AGENT_ID" \\',
      '  --name user-chat-42',
    ],
  },
  {
    title: 'Add the message',
    note: 'Appending and generating are separate calls, so a client can batch input before spending a token.',
    lines: [
      'soat add-session-message \\',
      '  --session-id "$SESSION_ID" \\',
      '  --message "Hello!"',
    ],
  },
  {
    title: 'Generate the answer',
    note: 'The reply comes back with a trace: every tool call, model response and token count, attributable to the agent version that served it.',
    lines: [
      'soat generate-session-response \\',
      '  --session-id "$SESSION_ID"',
    ],
  },
];

const HomepageTerminal = (): React.ReactNode => {
  const [active, setActive] = React.useState<number | null>(null);

  return (
    <section className={clsx(shared.band, styles.section)}>
      <div className="container">
        <div className={styles.layout}>
          <div className={styles.copy}>
            <p className={shared.eyebrow}>From zero to a running agent</p>
            <Heading as="h2" className={shared.title}>
              Four commands. Every one of them recorded.
            </Heading>
            <p className={shared.lead}>
              The CLI is the whole API as sub-commands, so the shortest path to
              a working agent is also a script you can commit.
            </p>
            <ol className={styles.notes}>
              {STEPS.map((step, index) => {
                return (
                  <li
                    key={step.title}
                    className={clsx(
                      styles.note,
                      active === index && styles.noteActive
                    )}
                    onMouseEnter={() => {
                      setActive(index);
                    }}
                    onMouseLeave={() => {
                      setActive(null);
                    }}
                  >
                    <span className={styles.noteIndex}>{index + 1}</span>
                    <div>
                      <Heading as="h3" className={styles.noteTitle}>
                        {step.title}
                      </Heading>
                      <p className={styles.noteText}>{step.note}</p>
                    </div>
                  </li>
                );
              })}
            </ol>
            <Link
              className="button button--primary button--lg"
              to="/docs/modules/agents"
            >
              Read the Agents docs
            </Link>
          </div>

          <div className={styles.terminal} aria-label="Terminal session">
            <div className={styles.titleBar}>
              <span className={styles.titleTab}>soat · bash</span>
              <span className={styles.titleStatus}>exit 0</span>
            </div>
            <pre className={styles.screen}>
              {STEPS.map((step, index) => {
                return (
                  <code
                    key={step.title}
                    className={clsx(
                      styles.block,
                      active !== null && active !== index && styles.blockDim,
                      active === index && styles.blockActive
                    )}
                  >
                    <span className={styles.marker} aria-hidden="true">
                      {index + 1}
                    </span>
                    {step.lines.map((line, lineIndex) => {
                      return (
                        <span className={styles.line} key={line}>
                          <span className={styles.prompt} aria-hidden="true">
                            {lineIndex === 0 ? '$' : ' '}
                          </span>
                          <span
                            className={
                              lineIndex === 0 ? styles.command : styles.arg
                            }
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
                  <span className={styles.prompt} aria-hidden="true">
                    {' '}
                  </span>
                  <span className={styles.comment}>
                    # the answer, plus a trace_id you can open in the console
                  </span>
                </span>
              </code>
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
};

export default HomepageTerminal;
