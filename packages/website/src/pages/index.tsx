import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import HomepageFeatures from '@site/src/components/HomepageFeatures';
import CodeBlock from '@theme/CodeBlock';
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
            <CodeBlock language="bash" title="Terminal">
              {`# 1. Create a session
soat create-agent-session --agent-id "agt_123" --auto-generate

# 2. Send a message — get the reply
soat generate-session-response \\
  --agent-id "agt_123" \\
  --session-id "ses_456" \\
  --content "Summarize the release notes."

# → { 
#     "role": "assistant",
#     "content": "Here are the highlights..." 
#   }`}
            </CodeBlock>
          </div>
        </div>
      </div>
    </section>
  );
};

const IconRestApi = () => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 48 48"
      className={styles.surfaceIcon}
    >
      <rect
        x="4"
        y="10"
        width="40"
        height="28"
        rx="4"
        stroke="currentColor"
        strokeWidth="2.5"
        fill="none"
      />
      <path
        d="M12 24h24M12 18h16M12 30h20"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="38" cy="18" r="2" fill="currentColor" opacity="0.6" />
    </svg>
  );
};

const IconMcp = () => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 48 48"
      className={styles.surfaceIcon}
    >
      <circle
        cx="24"
        cy="24"
        r="10"
        stroke="currentColor"
        strokeWidth="2.5"
        fill="none"
      />
      <circle cx="24" cy="24" r="3" fill="currentColor" opacity="0.7" />
      <line
        x1="24"
        y1="4"
        x2="24"
        y2="14"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <line
        x1="24"
        y1="34"
        x2="24"
        y2="44"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <line
        x1="4"
        y1="24"
        x2="14"
        y2="24"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <line
        x1="34"
        y1="24"
        x2="44"
        y2="24"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
};

const IconCli = () => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 48 48"
      className={styles.surfaceIcon}
    >
      <rect
        x="4"
        y="8"
        width="40"
        height="32"
        rx="4"
        stroke="currentColor"
        strokeWidth="2.5"
        fill="none"
      />
      <polyline
        points="12,22 18,28 12,34"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <line
        x1="22"
        y1="34"
        x2="34"
        y2="34"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
};

const IconSdk = () => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 48 48"
      className={styles.surfaceIcon}
    >
      <polyline
        points="16,14 6,24 16,34"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <polyline
        points="32,14 42,24 32,34"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <line
        x1="28"
        y1="10"
        x2="20"
        y2="38"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
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
        <div className={clsx('row', styles.surfacesRow)}>
          <div className={clsx('col col--3', styles.surfaceCard)}>
            <Link to="/docs/api" className={styles.surfaceLink}>
              <IconRestApi />
              <Heading as="h3">REST API</Heading>
              <p>OpenAPI-described HTTP endpoints for any backend.</p>
            </Link>
          </div>
          <div className={clsx('col col--3', styles.surfaceCard)}>
            <Link to="/docs/mcp" className={styles.surfaceLink}>
              <IconMcp />
              <Heading as="h3">MCP Server</Heading>
              <p>Plug into Claude Desktop, Cursor, or any MCP runtime.</p>
            </Link>
          </div>
          <div className={clsx('col col--3', styles.surfaceCard)}>
            <Link to="/docs/cli" className={styles.surfaceLink}>
              <IconCli />
              <Heading as="h3">CLI</Heading>
              <p>
                The <code>soat</code> command for scripts and CI pipelines.
              </p>
            </Link>
          </div>
          <div className={clsx('col col--3', styles.surfaceCard)}>
            <Link to="/docs/sdk" className={styles.surfaceLink}>
              <IconSdk />
              <Heading as="h3">TypeScript SDK</Heading>
              <p>Typed client generated from the OpenAPI spec.</p>
            </Link>
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
