import Link from '@docusaurus/Link';
import shared from '@site/src/components/HomepageShared/styles.module.css';
import Heading from '@theme/Heading';
import clsx from 'clsx';
import type * as React from 'react';

import styles from './styles.module.css';

const FACTS = [
  { value: 'Apache 2.0', label: 'licensed, nothing withheld' },
  { value: '1 process', label: 'Node.js on PostgreSQL + pgvector' },
  { value: '4 surfaces', label: 'REST, MCP, CLI, SDK' },
  { value: '0 signups', label: 'self-hosted, self-serve keys' },
];

type Node = { id: string; label: string; x: number; y: number };

const CORE = { x: 320, y: 300 };

const INNER: Node[] = [
  { id: 'sessions', label: 'sessions', x: 320, y: 160 },
  { id: 'knowledge', label: 'knowledge', x: 441, y: 230 },
  { id: 'tools', label: 'tools', x: 441, y: 370 },
  { id: 'guardrails', label: 'guardrails', x: 320, y: 440 },
  { id: 'traces', label: 'traces', x: 199, y: 370 },
  { id: 'iam', label: 'iam', x: 199, y: 230 },
];

const OUTER: Node[] = [
  { id: 'orchestrations', label: 'orchestrations', x: 445, y: 83 },
  { id: 'memories', label: 'memories', x: 570, y: 300 },
  { id: 'approvals', label: 'approvals', x: 445, y: 517 },
  { id: 'evaluations', label: 'evaluations', x: 195, y: 517 },
  { id: 'formations', label: 'formations', x: 70, y: 300 },
  { id: 'workflows', label: 'workflows', x: 195, y: 83 },
];

const LINKS: Array<[string, string]> = [
  ['sessions', 'workflows'],
  ['sessions', 'orchestrations'],
  ['knowledge', 'orchestrations'],
  ['knowledge', 'memories'],
  ['tools', 'memories'],
  ['tools', 'approvals'],
  ['guardrails', 'approvals'],
  ['guardrails', 'evaluations'],
  ['traces', 'evaluations'],
  ['traces', 'formations'],
  ['iam', 'formations'],
  ['iam', 'workflows'],
];

const byId = new Map(
  [...INNER, ...OUTER].map((node) => {
    return [node.id, node];
  })
);

const Constellation = () => {
  return (
    <svg
      className={styles.constellation}
      viewBox="0 0 640 600"
      role="img"
      aria-label="SOAT modules drawn as a constellation around the agent: sessions, knowledge, tools, guardrails, traces and IAM on the inner ring; orchestrations, memories, approvals, evaluations, formations and workflows on the outer ring."
    >
      <defs>
        <radialGradient id="soat-core" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="35%" stopColor="#00e5ff" />
          <stop offset="100%" stopColor="#8e44ad" stopOpacity="0" />
        </radialGradient>
        <filter id="soat-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="6" />
        </filter>
      </defs>

      <circle className={styles.orbit} cx={CORE.x} cy={CORE.y} r="140" />
      <circle className={styles.orbit} cx={CORE.x} cy={CORE.y} r="250" />

      {INNER.map((node) => {
        return (
          <line
            key={`core-${node.id}`}
            className={styles.edge}
            x1={CORE.x}
            y1={CORE.y}
            x2={node.x}
            y2={node.y}
          />
        );
      })}
      {LINKS.map(([from, to]) => {
        const a = byId.get(from);
        const b = byId.get(to);
        if (!a || !b) return null;
        return (
          <line
            key={`${from}-${to}`}
            className={clsx(styles.edge, styles.edgeFaint)}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
          />
        );
      })}

      {INNER.slice(0, 3).map((node, index) => {
        return (
          <circle
            key={`pulse-${node.id}`}
            className={styles.pulse}
            r="2.5"
            style={{ animationDelay: `${index * 1.3}s` }}
          >
            <animateMotion
              dur="4.2s"
              repeatCount="indefinite"
              begin={`${index * 1.3}s`}
              path={`M${node.x},${node.y} L${CORE.x},${CORE.y}`}
            />
          </circle>
        );
      })}

      <circle
        cx={CORE.x}
        cy={CORE.y}
        r="46"
        fill="url(#soat-core)"
        opacity="0.55"
        filter="url(#soat-glow)"
      />
      <circle cx={CORE.x} cy={CORE.y} r="18" fill="url(#soat-core)" />
      <text
        className={styles.coreLabel}
        x={CORE.x}
        y={CORE.y + 4}
        textAnchor="middle"
      >
        agent
      </text>

      {[...INNER, ...OUTER].map((node, index) => {
        const outer = OUTER.includes(node);
        return (
          <g
            key={node.id}
            className={styles.node}
            style={{ animationDelay: `${(index % 5) * -1.7}s` }}
          >
            <circle
              className={outer ? styles.dotOuter : styles.dotInner}
              cx={node.x}
              cy={node.y}
              r={outer ? 5 : 6}
            />
            <text
              className={styles.label}
              x={node.x}
              y={node.y + (node.y < CORE.y ? -14 : 24)}
              textAnchor="middle"
            >
              {node.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

const HomepageHero = (): React.ReactNode => {
  return (
    <header className={clsx(shared.bleed, styles.hero)}>
      <div className={clsx('container', styles.inner)}>
        <div className={styles.copy}>
          <p className={clsx(shared.eyebrow, styles.eyebrow)}>
            Open source · Self-hosted · Apache 2.0
          </p>
          <Heading as="h1" className={styles.title}>
            The infrastructure layer for{' '}
            <span className={styles.titleGlow}>production-ready</span> AI
            agents.
          </Heading>
          <p className={styles.subtitle}>
            Sessions, knowledge, memory, orchestration, guardrails, IAM,
            evaluations and traces from one self-hosted Node.js server on
            PostgreSQL. Reachable over REST, MCP, the CLI and the SDK.
          </p>
          <div className={styles.actions}>
            <Link
              className="button button--primary button--lg"
              to="/docs/getting-started"
            >
              Get started in 5 minutes
            </Link>
            <Link
              className={shared.ghostButton}
              to="https://github.com/ttoss/soat"
            >
              Star on GitHub
            </Link>
          </div>
          <Link className={styles.command} to="/docs/getting-started">
            <span className={styles.prompt} aria-hidden="true">
              $
            </span>
            <code>docker compose up -d</code>
            <span className={styles.commandHint}>
              PostgreSQL, Ollama and the server. Runs offline.
            </span>
          </Link>
        </div>
        <div className={styles.visual}>
          <Constellation />
        </div>
      </div>
      <div className={clsx('container', styles.facts)}>
        {FACTS.map((fact) => {
          return (
            <div className={styles.fact} key={fact.value}>
              <span className={styles.factValue}>{fact.value}</span>
              <span className={styles.factLabel}>{fact.label}</span>
            </div>
          );
        })}
      </div>
    </header>
  );
};

export default HomepageHero;
