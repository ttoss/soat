import Link from '@docusaurus/Link';
import shared from '@site/src/components/HomepageShared/styles.module.css';
import Heading from '@theme/Heading';
import clsx from 'clsx';
import type * as React from 'react';

import styles from './styles.module.css';

type Layer = {
  name: string;
  question: string;
  summary: string;
  modules: Array<{ label: string; href: string }>;
};

const LAYERS: Layer[] = [
  {
    name: 'Harness',
    question: 'What can this agent reach, and what is it forbidden?',
    summary:
      'Most failures live here, and so do the cheapest wins. Tools are first-class resources, knowledge and memory are scoped, and every permission is a policy document.',
    modules: [
      { label: 'tools', href: '/docs/modules/tools' },
      { label: 'knowledge', href: '/docs/modules/knowledge' },
      { label: 'documents', href: '/docs/modules/documents' },
      { label: 'memories', href: '/docs/modules/memories' },
      { label: 'sessions', href: '/docs/modules/sessions' },
      { label: 'iam', href: '/docs/modules/iam' },
      { label: 'secrets', href: '/docs/modules/secrets' },
    ],
  },
  {
    name: 'Loop',
    question: 'What proves it did the job, and when does it stop?',
    summary:
      'Output schemas, step limits and stop conditions bound the run. Guardrails classify every tool call before it executes, quotas fail closed, and each generation writes a trace.',
    modules: [
      { label: 'agents', href: '/docs/modules/agents' },
      { label: 'guardrails', href: '/docs/modules/guardrails' },
      { label: 'approvals', href: '/docs/modules/approvals' },
      { label: 'quotas', href: '/docs/modules/quotas' },
      { label: 'usage', href: '/docs/modules/usage' },
      { label: 'traces', href: '/docs/modules/traces' },
      { label: 'exceptions', href: '/docs/modules/exceptions' },
    ],
  },
  {
    name: 'Graph',
    question: 'What is allowed to happen next?',
    summary:
      'DAG orchestrations with parallel rounds, state-machine workflows for long-running work, and triggers on a cron, a webhook or an event. Built last, because it is needed least often.',
    modules: [
      { label: 'orchestrations', href: '/docs/modules/orchestrations' },
      { label: 'workflows', href: '/docs/modules/workflows' },
      { label: 'triggers', href: '/docs/modules/triggers' },
    ],
  },
  {
    name: 'Ratchet',
    question:
      'How does the system change, and what proves the change was an improvement?',
    summary:
      'Agent versions are append-only, a canary splits traffic, and promotion waits for a passing eval run against that canary. The platform owns the verdict; a human owns the judgment.',
    modules: [
      { label: 'evaluations', href: '/docs/modules/evaluations' },
      {
        label: 'agent versions',
        href: '/docs/modules/agents#versioning-and-staged-rollout',
      },
      {
        label: 'recurrence view',
        href: '/docs/modules/approvals#recurrence-view',
      },
      { label: 'formations', href: '/docs/modules/formations' },
    ],
  },
];

const HomepageLayers = (): React.ReactNode => {
  return (
    <section
      className={clsx(shared.band, shared.bleed, shared.dark, styles.section)}
    >
      <div className="container">
        <div className={styles.header}>
          <div>
            <p className={shared.eyebrow}>The four layers of an agent system</p>
            <Heading as="h2" className={shared.title}>
              Harness first. Loop second. Graph last. Then the ratchet.
            </Heading>
          </div>
          <p className={shared.lead}>
            An agent system decomposes into four layers, and the investment
            order is not equal. SOAT is built around that order: every module
            owns one layer, so when a layer is the one failing you know which
            part of the platform to reach for.{' '}
            <Link to="/docs/agent-system-layers">Read the framing</Link>.
          </p>
        </div>

        <ol className={styles.strata}>
          {LAYERS.map((layer, index) => {
            return (
              <li
                className={clsx(
                  styles.stratum,
                  index === LAYERS.length - 1 && styles.stratumRatchet
                )}
                key={layer.name}
              >
                <span className={styles.index} aria-hidden="true">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <div className={styles.body}>
                  <Heading as="h3" className={styles.name}>
                    {layer.name}
                    {index === LAYERS.length - 1 && (
                      <span className={styles.badge}>
                        governs change itself
                      </span>
                    )}
                  </Heading>
                  <p className={styles.question}>{layer.question}</p>
                  <p className={styles.summary}>{layer.summary}</p>
                </div>
                <ul className={styles.modules}>
                  {layer.modules.map((module) => {
                    return (
                      <li key={module.label}>
                        <Link
                          className={clsx(shared.mono, styles.module)}
                          to={module.href}
                        >
                          {module.label}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
};

export default HomepageLayers;
