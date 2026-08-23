import Head from '@docusaurus/Head';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import HomepageOnboarding from '@site/src/components/HomepageOnboarding';
import HomepageSurfaces from '@site/src/components/HomepageSurfaces';
import HomepageWhenToUse from '@site/src/components/HomepageWhenToUse';
import { AGENT_RESOURCES } from '@site/src/data/agentResources';
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
      'Agents call tools and other agents. DAG orchestrations and workflow state machines turn them into deterministic, multi-step workflows.',
  },
  {
    title: 'Remember',
    description:
      'Knowledge search and memories retrieve context, while ingestion rules turn PDFs, images, and audio into searchable documents.',
  },
  {
    title: 'Govern',
    description:
      'IAM policies, API keys, OAuth for MCP clients, and scoped secrets keep every operation bounded.',
  },
  {
    title: 'Observe & Improve',
    description:
      'Traces capture every tool call and model response. Append-only agent versions, canary rollouts, and eval-gated promotion make every change attributable, reversible, and measured before it ships.',
  },
];

const formationSteps = [
  {
    title: 'Declare',
    description:
      'Describe providers, memories, tools, agents, orchestrations, documents, and webhooks in one JSON or YAML template.',
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
          Durable sessions, multi-agent orchestration, knowledge, memory,
          guardrails, IAM, and traces — all from one self-hosted Node.js server.
        </p>
        <div className={clsx(styles.buttons, styles.heroButtons)}>
          <Link
            className="button button--primary button--lg"
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
          Apache 2.0 licensed · No vendor lock-in · One Docker Compose away
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
              SOAT packages storage, orchestration, retrieval, governance, and
              observability into one Node.js process backed by PostgreSQL and
              pgvector. The REST API and MCP endpoint share the same business
              logic and permission engine — no queue, vector service, or
              separate auth server to wire up.
            </p>
            <p className={styles.architectureLead}>
              It&apos;s organized around the{' '}
              <Link to="/docs/agent-system-layers">
                four layers of an agent system
              </Link>{' '}
              — the harness, the loop, the graph, and the ratchet.
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
              From zero to a running agent in four commands.
            </Heading>
            <p>
              Create an agent, open a session to persist conversation state,
              send a message, and generate the answer — all from the CLI. Every
              step is recorded as a traceable operation.
            </p>
            <ul className={styles.checkList}>
              <li>Attach any AI provider with a single flag</li>
              <li>Sessions accumulate message history automatically</li>
              <li>Traces capture every tool call and model response</li>
            </ul>
            <Link
              className="button button--primary button--lg"
              to="/docs/modules/agents"
            >
              Read the Agents docs
            </Link>
          </div>
          <div className={clsx('col col--6', styles.showcaseCode)}>
            <CodeBlock language="bash" title="Terminal">
              {`soat create-agent \\
  --project-id "$PROJECT_ID" \\
  --ai-provider-id "$PROVIDER_ID" \\
  --name "support-bot" \\
  --instructions "You are a helpful support assistant."

soat create-session \\
  --agent-id "$AGENT_ID" \\
  --name "user-chat-42"

soat add-session-message \\
  --session-id "$SESSION_ID" \\
  --message "Hello!"

soat generate-session-response \\
  --session-id "$SESSION_ID"`}
            </CodeBlock>
          </div>
        </div>
      </div>
    </section>
  );
};

const AgentSurfaces = () => {
  return (
    <section className={styles.agents}>
      <div className="container">
        <div className={styles.agentsHeader}>
          <p className={styles.eyebrow}>Built for agents</p>
          <Heading as="h2">
            Everything on this site is readable by a machine.
          </Heading>
          <p>
            SOAT is infrastructure for agents, so its documentation is published
            the way an agent wants to read it. Every page is server-rendered —
            the full text is in the HTML, with no JavaScript required — and has
            a Markdown twin one URL away. The REST surface is published as a
            single OpenAPI description, and the error contract as a catalog of
            stable codes, so a client can be generated and its failures handled
            without scraping a page.
          </p>
        </div>
        <div className={styles.agentGrid}>
          {AGENT_RESOURCES.map((resource) => {
            return (
              <div className={styles.agentCard} key={resource.href}>
                <a href={resource.href}>{resource.title}</a>
                <p>{resource.description}</p>
                <span className={styles.agentCardMeta}>
                  {resource.mediaType}
                </span>
              </div>
            );
          })}
        </div>
        <p className={styles.agentsNote}>
          Send <code>Accept: text/markdown</code> to any documentation URL and
          that page answers in Markdown — or append <code>.md</code> for the
          same file by name, for example{' '}
          <a href="/docs/introduction.md">/docs/introduction.md</a>. Every HTML
          page advertises its own twin with a{' '}
          <code>
            &lt;link rel=&quot;alternate&quot;
            type=&quot;text/markdown&quot;&gt;
          </code>{' '}
          tag, and dead URLs answer with a real HTTP 404 carrying a Markdown
          recovery map instead of a soft 200.
        </p>
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
          Self-host SOAT and ship agents that can reach what they need, prove
          they did the job, and improve on evidence — sessions, knowledge,
          memory, IAM, guardrails, versions, traces, and MCP on your own
          infrastructure.
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
        <p className={styles.finalNote}>
          Weighing your options?{' '}
          <Link to="/benchmark">
            See how SOAT compares to other agent solutions
          </Link>
          .
        </p>
      </div>
    </section>
  );
};

export default function Home(): React.ReactNode {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout
      title={`${siteConfig.title} — Infrastructure for production-ready AI agents`}
      description="Durable sessions, multi-agent orchestration, knowledge, memory, guardrails, IAM, and traces — all from one self-hosted Node.js server."
    >
      {/* The homepage is the only page with no Markdown twin of its own, so it
          is the one place the agent instruction file can be advertised as an
          alternate without competing with a page's own `.md` link. The edge
          function resolves `Accept: text/markdown` on `/` to this same file
          (`cloudfront/viewerRequest.js`), so what the page advertises and what
          negotiation returns are one thing. */}
      <Head>
        <link
          rel="alternate"
          type="text/markdown"
          title="Agent instructions"
          href="/agents.md"
        />
      </Head>
      {/* The <h1> lives inside <main> on purpose: content extractors (and the
          AI crawlers built on them) read the main content region, and a hero
          heading parked outside it reads as a page with no heading at all. */}
      <main>
        <HomepageHeader />
        <ArchitectureBand />
        <HomepageSurfaces />
        <FormationsSpotlight />
        <CodeShowcase />
        <HomepageWhenToUse />
        <HomepageOnboarding />
        <AgentSurfaces />
        <FinalCta />
      </main>
    </Layout>
  );
}
