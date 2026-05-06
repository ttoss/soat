import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import HomepageFeatures from '@site/src/components/HomepageFeatures';
import Heading from '@theme/Heading';
import Layout from '@theme/Layout';
import clsx from 'clsx';
import type * as React from 'react';

import styles from './index.module.css';

const HomepageHeader = () => {
  return (
    <header className={clsx('hero hero--primary', styles.heroBanner)}>
      <div className="container">
        <Heading as="h1" className="hero__title">
          The complete backend for AI apps.
        </Heading>
        <p className="hero__subtitle">
          Open-source infrastructure for agents, RAG, and conversations — with
          IAM, vector search, and MCP built in. Self-host in 5 minutes.
        </p>
        <div className={styles.buttons}>
          <Link
            className="button button--secondary button--lg"
            to="/docs/getting-started"
          >
            Get Started — 5 min
          </Link>
          <Link
            className={clsx(
              'button button--outline button--secondary button--lg',
              styles.secondaryButton
            )}
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

const CodeShowcase = () => {
  return (
    <section className={styles.showcase}>
      <div className="container">
        <div className="row">
          <div className={clsx('col col--6', styles.showcaseCopy)}>
            <Heading as="h2">
              From zero to a working agent in two calls.
            </Heading>
            <p>
              Spin up SOAT, point it at any OpenAI-compatible LLM, and ship a
              tool-calling agent with persistent memory and full traces —
              without writing a single line of backend code.
            </p>
            <ul className={styles.checkList}>
              <li>Configure providers, agents, and tools through the API</li>
              <li>Sessions handle conversation history automatically</li>
              <li>Plug it into Claude Desktop or Cursor over MCP</li>
            </ul>
            <Link
              className="button button--primary button--lg"
              to="/docs/getting-started"
            >
              Try it now
            </Link>
          </div>
          <div className={clsx('col col--6', styles.showcaseCode)}>
            <pre>
              <code>{`# 1. Send a message to your agent
curl -X POST $SOAT/api/v1/agents/agt_123/sessions/ses_456/messages \\
  -H "Authorization: Bearer $TOKEN" \\
  -d '{"content":"Summarize the latest release notes."}'

# 2. Get the assistant reply
# (auto_generate handles tool calls, history, and the LLM round-trip)
{
  "role": "assistant",
  "content": "Here are the highlights from v2.3 ..."
}`}</code>
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
};

const SurfacesStrip = () => {
  return (
    <section className={styles.surfaces}>
      <div className="container">
        <Heading as="h2" className="text--center">
          One backend. Four ways to call it.
        </Heading>
        <p className={clsx('text--center', styles.surfacesLead)}>
          Every operation in SOAT is reachable through the surface that fits the
          job. Same permissions, same data, same business logic.
        </p>
        <div className="row">
          <div className={clsx('col col--3', styles.surfaceCard)}>
            <Heading as="h3">REST API</Heading>
            <p>OpenAPI-described HTTP endpoints for any backend.</p>
          </div>
          <div className={clsx('col col--3', styles.surfaceCard)}>
            <Heading as="h3">MCP Server</Heading>
            <p>Plug into Claude Desktop, Cursor, or any MCP runtime.</p>
          </div>
          <div className={clsx('col col--3', styles.surfaceCard)}>
            <Heading as="h3">CLI</Heading>
            <p>
              The <code>soat</code> command for scripts and CI pipelines.
            </p>
          </div>
          <div className={clsx('col col--3', styles.surfaceCard)}>
            <Heading as="h3">TypeScript SDK</Heading>
            <p>Typed client generated from the OpenAPI spec.</p>
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
        <Heading as="h2">Stop rebuilding the same AI plumbing.</Heading>
        <p className={styles.finalLead}>
          Self-host SOAT and ship agents, RAG, and conversational memory on your
          own infrastructure — open source, MIT licensed.
        </p>
        <div className={styles.buttons}>
          <Link
            className="button button--primary button--lg"
            to="/docs/getting-started"
          >
            Run it locally
          </Link>
          <Link
            className="button button--outline button--primary button--lg"
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
      title={`${siteConfig.title} — The complete backend for AI apps`}
      description="Open-source infrastructure for AI applications — agents, RAG, conversations, IAM, vector search, and MCP, all in one self-hostable server."
    >
      <HomepageHeader />
      <main>
        <HomepageFeatures />
        <CodeShowcase />
        <SurfacesStrip />
        <FinalCta />
      </main>
    </Layout>
  );
}
