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

type Node = {
  id: string;
  ring: 1 | 2;
  angle: number;
};

const CORE = { x: 360, y: 310 };
const RING_RADIUS = { 1: 150, 2: 240 } as const;
const GALAXY_RADIUS = 130;
/* Every edge bends by this much in the direction the galaxy turns, so the
   graph reads as arms sweeping out of the spiral rather than as spokes. */
const SWEEP_DEGREES = 22;

/* Inner nodes sit 30 degrees off the outer ones, so each inner node has an
   outer neighbour on either side and no outer node lands on the horizontal
   axis, where its label would run off the edge. */
const NODES: Node[] = [
  { id: 'sessions', ring: 1, angle: -75 },
  { id: 'knowledge', ring: 1, angle: -15 },
  { id: 'tools', ring: 1, angle: 45 },
  { id: 'guardrails', ring: 1, angle: 105 },
  { id: 'traces', ring: 1, angle: 165 },
  { id: 'iam', ring: 1, angle: 225 },
  { id: 'orchestrations', ring: 2, angle: -45 },
  { id: 'memories', ring: 2, angle: 15 },
  { id: 'approvals', ring: 2, angle: 75 },
  { id: 'evaluations', ring: 2, angle: 135 },
  { id: 'formations', ring: 2, angle: 195 },
  { id: 'workflows', ring: 2, angle: 255 },
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

const toRadians = (degrees: number) => {
  return (degrees * Math.PI) / 180;
};

const polar = (args: { radius: number; angle: number }) => {
  return {
    x: CORE.x + args.radius * Math.cos(toRadians(args.angle)),
    y: CORE.y + args.radius * Math.sin(toRadians(args.angle)),
  };
};

const position = (node: Node) => {
  return polar({ radius: RING_RADIUS[node.ring], angle: node.angle });
};

const sweep = (
  from: { radius: number; angle: number },
  to: { radius: number; angle: number }
) => {
  const a = polar(from);
  const b = polar(to);
  const control = polar({
    radius: (from.radius + to.radius) / 2,
    angle: (from.angle + to.angle) / 2 + SWEEP_DEGREES,
  });
  return `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${control.x.toFixed(1)},${control.y.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
};

const armPath = (node: Node) => {
  return sweep(
    { radius: GALAXY_RADIUS * 0.55, angle: node.angle - 50 },
    { radius: RING_RADIUS[node.ring], angle: node.angle }
  );
};

const labelPlacement = (node: Node) => {
  const point = position(node);
  const cos = Math.cos(toRadians(node.angle));
  const sin = Math.sin(toRadians(node.angle));
  const anchor: 'start' | 'end' | 'middle' =
    cos > 0.35 ? 'start' : cos < -0.35 ? 'end' : 'middle';
  return {
    x: point.x + cos * 15,
    y: point.y + sin * 15 + (anchor === 'middle' ? (sin > 0 ? 12 : -4) : 4),
    anchor,
  };
};

const byId = new Map(
  NODES.map((node) => {
    return [node.id, node];
  })
);

/* The three dots that travel the arms into the core. Hidden until their own
   start time, or they would sit at the SVG origin waiting. */
const Pulses = (args: { nodes: Node[] }) => {
  return (
    <>
      {args.nodes.map((node, index) => {
        return (
          <circle
            key={`pulse-${node.id}`}
            className={styles.pulse}
            r="2.5"
            visibility={index === 0 ? 'visible' : 'hidden'}
          >
            {index > 0 && (
              <set
                attributeName="visibility"
                to="visible"
                begin={`${index * 1.3}s`}
              />
            )}
            <animateMotion
              dur="4.2s"
              repeatCount="indefinite"
              begin={`${index * 1.3}s`}
              keyPoints="1;0"
              keyTimes="0;1"
              calcMode="linear"
              path={armPath(node)}
            />
          </circle>
        );
      })}
    </>
  );
};

const Constellation = () => {
  const innerNodes = NODES.filter((node) => {
    return node.ring === 1;
  });

  return (
    <svg
      className={styles.constellation}
      viewBox="0 0 720 620"
      role="img"
      aria-label="SOAT modules drawn as a constellation around the Vector Galaxy logo, which stands for the agent: sessions, knowledge, tools, guardrails, traces and IAM on the inner orbit; orchestrations, memories, approvals, evaluations, formations and workflows on the outer orbit."
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

      <circle
        className={styles.orbit}
        cx={CORE.x}
        cy={CORE.y}
        r={RING_RADIUS[1]}
      />
      <circle
        className={styles.orbit}
        cx={CORE.x}
        cy={CORE.y}
        r={RING_RADIUS[2]}
      />
      <circle
        className={clsx(styles.orbit, styles.orbitFaint)}
        cx={CORE.x}
        cy={CORE.y}
        r={(RING_RADIUS[1] + RING_RADIUS[2]) / 2}
      />

      {innerNodes.map((node) => {
        return (
          <path
            key={`arm-${node.id}`}
            className={styles.edge}
            d={armPath(node)}
          />
        );
      })}
      {LINKS.map(([from, to]) => {
        const a = byId.get(from);
        const b = byId.get(to);
        if (!a || !b) return null;
        return (
          <path
            key={`${from}-${to}`}
            className={clsx(styles.edge, styles.edgeFaint)}
            d={sweep(
              { radius: RING_RADIUS[a.ring], angle: a.angle },
              { radius: RING_RADIUS[b.ring], angle: b.angle }
            )}
          />
        );
      })}

      <Pulses nodes={innerNodes.slice(0, 3)} />

      <circle
        cx={CORE.x}
        cy={CORE.y}
        r="80"
        fill="url(#soat-core)"
        opacity="0.35"
        filter="url(#soat-glow)"
      />
      <image
        className={styles.galaxy}
        href="/img/soat-logo-no-bg.png"
        x={CORE.x - GALAXY_RADIUS}
        y={CORE.y - GALAXY_RADIUS * 0.75}
        width={GALAXY_RADIUS * 2}
        height={GALAXY_RADIUS * 1.5}
        preserveAspectRatio="xMidYMid meet"
      />
      <rect
        className={styles.coreLabelBacking}
        x={CORE.x - 27}
        y={CORE.y + GALAXY_RADIUS * 0.75 + 6}
        width="54"
        height="20"
        rx="10"
      />
      <text
        className={styles.coreLabel}
        x={CORE.x}
        y={CORE.y + GALAXY_RADIUS * 0.75 + 20}
        textAnchor="middle"
      >
        agent
      </text>

      {NODES.map((node, index) => {
        const point = position(node);
        const label = labelPlacement(node);
        const outer = node.ring === 2;
        return (
          <g
            key={node.id}
            className={styles.node}
            style={{ animationDelay: `${(index % 5) * -1.7}s` }}
          >
            <circle
              className={outer ? styles.dotOuter : styles.dotInner}
              cx={point.x}
              cy={point.y}
              r={outer ? 5 : 6}
            />
            <text
              className={styles.label}
              x={label.x}
              y={label.y}
              textAnchor={label.anchor}
            >
              {node.id}
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
