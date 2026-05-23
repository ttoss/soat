import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import HomepageSurfaces from '@site/src/components/HomepageSurfaces';
import CodeBlock from '@theme/CodeBlock';
import Heading from '@theme/Heading';
import Layout from '@theme/Layout';
import clsx from 'clsx';
import type * as React from 'react';

import styles from './index.module.css';

const platformPillars = [
  {
    title: 'Build',
    description:
      'Projects, AI providers, secrets, files, and documents give agents a durable workspace.',
  },
  {
    title: 'Orchestrate',
    description:
      'Agents, tools, sessions, conversations, and actors handle real multi-step workflows.',
  },
  {
    title: 'Remember',
    description:
      'Knowledge search and memories retrieve context, deduplicate writes, and preserve useful facts.',
  },
  {
    title: 'Govern',
    description:
      'IAM policies, API keys, scoped secrets, and resource names keep every operation bounded.',
  },
  {
    title: 'Observe',
    description:
      'Traces and webhooks expose what agents did, which tools ran, and what changed downstream.',
  },
];

const formationSteps = [
  {
    title: 'Declare',
    description:
      'Describe providers, memories, tools, agents, documents, and webhooks in one JSON or YAML template.',
  },
  {
    title: 'Resolve',
    description:
      'SOAT builds the dependency graph, resolves refs, and provisions resources in the correct order.',
  },
  {
    title: 'Operate',
    description:
      'Every create, update, and delete operation is tracked with resources, outputs, and an immutable event log.',
  },
];

const HomepageHeader = () => {
  return (
    <header className={clsx('hero hero--primary', styles.heroBanner)}>
      <div className={clsx('container', styles.heroContent)}>
        <Heading as="h1" className={clsx('hero__title', styles.heroTitle)}>
          The infrastructure layer for production-ready AI agents.
        </Heading>
        <p className={clsx('hero__subtitle', styles.heroSubtitle)}>
          Run tool-calling agents with durable sessions, searchable knowledge,
          writable memory, scoped secrets, IAM policies, traces, and MCP from
          one self-hosted server.
        </p>
        <div className={clsx(styles.buttons, styles.heroButtons)}>
          <Link
            className="button button--secondary button--lg"
            to="/docs/getting-started"
          >
            Get Started — 5 min
          </Link>
          <Link
            className="button button--secondary button--lg"
            to="https://github.com/ttoss/soat"
          >
            Star on GitHub
          </Link>
        </div>
        <p className={styles.heroNote}>
          MIT licensed · No vendor lock-in · One Docker Compose away
        </p>
      </div>
    </header>
  );
};

const ArchitectureBand = () => {
  return (
    <section className={styles.architecture}>
      <div className="container">
        <div className={styles.architectureLayout}>
          <div className={styles.architectureIntro}>
            <p className={styles.eyebrow}>What SOAT provides</p>
            <Heading as="h2">
              One self-hosted layer for the agent backend stack.
            </Heading>
            <p className={styles.architectureLead}>
              SOAT packages the production services agents need into a single
              control surface: storage, orchestration, retrieval, governance,
              and observability.
            </p>
          </div>
          <div className={styles.architectureVisual}>
            <img
              src="/img/soat-architecture.png"
              alt="SOAT architecture visualization with connected infrastructure panels and a central vector galaxy"
            />
          </div>
          <div className={styles.platformPillars}>
            {platformPillars.map((pillar) => {
              return (
                <div className={styles.platformPillar} key={pillar.title}>
                  <Heading as="h3">{pillar.title}</Heading>
                  <p>{pillar.description}</p>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
};

const FormationsSpotlight = () => {
  return (
    <section className={styles.formations}>
      <div className="container">
        <div className={styles.formationsHeader}>
          <p className={styles.eyebrow}>Agent Formations</p>
          <Heading as="h2">
            Deploy complete agent stacks from one template.
          </Heading>
          <p>
            Agent Formations are the declarative deployment layer in SOAT.
            Define the desired stack once, preview the plan, then let SOAT
            create or update every dependent resource with consistent
            permissions and traceable operations.
          </p>
        </div>
        <div className={styles.formationSteps}>
          {formationSteps.map((step, index) => {
            return (
              <div className={styles.formationStep} key={step.title}>
                <span className={styles.formationStepNumber}>
                  {String(index + 1).padStart(2, '0')}
                </span>
                <Heading as="h3">{step.title}</Heading>
                <p>{step.description}</p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

const CodeShowcase = () => {
  return (
    <section className={styles.showcase}>
      <div className="container">
        <div className="row">
          <div className={clsx('col col--6', styles.showcaseCopy)}>
            <Heading as="h2">
              Plan, deploy, and inspect the stack from the CLI.
            </Heading>
            <p>
              Formations make an agent backend reproducible. The same template
              can create an AI provider, memory, tools, and the agent that uses
              them, while SOAT records outputs and operation events.
            </p>
            <ul className={styles.checkList}>
              <li>Define the stack once in a formation template</li>
              <li>Preview changes before deployment with a plan</li>
              <li>Use refs instead of hand-wiring generated resource IDs</li>
            </ul>
            <Link
              className="button button--primary button--lg"
              to="/docs/modules/formations"
            >
              Read Agent Formations
            </Link>
          </div>
          <div className={clsx('col col--6', styles.showcaseCode)}>
            <CodeBlock language="bash" title="Terminal">
              {`TEMPLATE=$(cat agent-stack.json)

soat plan-agent-formation \\
  --template "$TEMPLATE"

soat create-agent-formation \\
  --name "support-stack" \\
  --template "$TEMPLATE"

soat list-agent-formation-events \\
  --formation_id "af_V1StGXR8Z5jdHi6B"`}
            </CodeBlock>
          </div>
        </div>
      </div>
    </section>
  );
};

const FinalCta = () => {
  return (
    <section className={styles.finalCta}>
      <div className="container text--center">
        <Heading as="h2">Stop rebuilding agent infrastructure.</Heading>
        <p className={styles.finalLead}>
          Self-host SOAT and ship production-ready agents with sessions,
          knowledge, memory, IAM, traces, and MCP on your own infrastructure.
        </p>
        <div className={styles.buttons}>
          <Link
            className="button button--primary button--lg"
            to="/docs/getting-started"
          >
            Run it locally
          </Link>
          <Link
            className="button button--secondary button--lg"
            to="/docs/introduction"
          >
            Read the docs
          </Link>
        </div>
      </div>
    </section>
  );
};

export default function Home(): React.ReactNode {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout
      title={`${siteConfig.title} — Infrastructure for production-ready AI agents`}
      description="Run tool-calling agents with durable sessions, searchable knowledge, writable memory, scoped secrets, IAM policies, traces, and MCP from one self-hosted server."
    >
      <HomepageHeader />
      <main>
        <ArchitectureBand />
        <FormationsSpotlight />
        <HomepageSurfaces />
        <CodeShowcase />
        <FinalCta />
      </main>
    </Layout>
  );
}
