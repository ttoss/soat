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

/* The logo bitmap's own geometry: its size and where its recall-core sits.
   Node positions are pixel coordinates on the bitmap, sampled where a spiral
   arm is brightest, so every module dot lands on an arm and not beside it. */
const LOGO = { width: 573, height: 435, coreX: 286, coreY: 211 };

const VIEW = { width: 700, height: 560 };
const LOGO_SCALE = 620 / LOGO.width;
const LOGO_ORIGIN = {
  x: (VIEW.width - LOGO.width * LOGO_SCALE) / 2,
  y: (VIEW.height - LOGO.height * LOGO_SCALE) / 2,
};

type Node = { id: string; x: number; y: number; below?: boolean };

const NODES: Node[] = [
  { id: 'formations', x: 63, y: 195 },
  { id: 'iam', x: 148, y: 149 },
  { id: 'workflows', x: 163, y: 75 },
  { id: 'sessions', x: 274, y: 104 },
  { id: 'orchestrations', x: 322, y: 64 },
  { id: 'knowledge', x: 420, y: 162 },
  { id: 'memories', x: 488, y: 225 },
  { id: 'tools', x: 426, y: 285 },
  { id: 'guardrails', x: 365, y: 299, below: true },
  { id: 'approvals', x: 360, y: 395 },
  { id: 'evaluations', x: 187, y: 320 },
  { id: 'traces', x: 155, y: 269 },
];

const toView = (point: { x: number; y: number }) => {
  return {
    x: LOGO_ORIGIN.x + point.x * LOGO_SCALE,
    y: LOGO_ORIGIN.y + point.y * LOGO_SCALE,
  };
};

const CORE = toView({ x: LOGO.coreX, y: LOGO.coreY });

/* Labels sit on the far side of their dot from the core, so none of them
   crosses the spiral toward the center. */
const LABEL_CHAR_WIDTH = 7.6;
const LABEL_HEIGHT = 18;

const labelPlacement = (node: Node) => {
  const point = toView(node);
  const dx = point.x - CORE.x;
  const dy = point.y - CORE.y;
  const length = Math.hypot(dx, dy) || 1;
  const cos = node.below ? 0 : dx / length;
  const sin = node.below ? 1 : dy / length;
  const anchor: 'start' | 'end' | 'middle' =
    cos > 0.4 ? 'start' : cos < -0.4 ? 'end' : 'middle';
  const x = point.x + cos * 15;
  const y =
    point.y + sin * 15 + (anchor === 'middle' ? (sin > 0 ? 13 : -5) : 4);
  const width = node.id.length * LABEL_CHAR_WIDTH + 12;
  const boxX =
    anchor === 'start'
      ? x - 6
      : anchor === 'end'
        ? x - width + 6
        : x - width / 2;
  return { x, y, anchor, box: { x: boxX, y: y - 13, width } };
};

const Constellation = () => {
  return (
    <svg
      className={styles.constellation}
      viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}
      role="img"
      aria-label="The SOAT Vector Galaxy logo with the platform's modules marked along its spiral arms: formations, IAM, workflows, sessions, orchestrations, knowledge, memories, tools, guardrails, approvals, evaluations and traces, with the agent at the core."
    >
      <image
        className={styles.galaxy}
        href="/img/soat-logo-no-bg.png"
        x={LOGO_ORIGIN.x}
        y={LOGO_ORIGIN.y}
        width={LOGO.width * LOGO_SCALE}
        height={LOGO.height * LOGO_SCALE}
      />

      <rect
        className={styles.coreLabelBacking}
        x={CORE.x - 27}
        y={CORE.y + 30}
        width="54"
        height="20"
        rx="10"
      />
      <text
        className={styles.coreLabel}
        x={CORE.x}
        y={CORE.y + 44}
        textAnchor="middle"
      >
        agent
      </text>

      {NODES.map((node, index) => {
        const point = toView(node);
        const label = labelPlacement(node);
        return (
          <g key={node.id}>
            <circle
              className={styles.halo}
              cx={point.x}
              cy={point.y}
              r="11"
              style={{ animationDelay: `${(index % 6) * -0.7}s` }}
            />
            <circle className={styles.dot} cx={point.x} cy={point.y} r="4.5" />
            <rect
              className={styles.labelBacking}
              x={label.box.x}
              y={label.box.y}
              width={label.box.width}
              height={LABEL_HEIGHT}
              rx="9"
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
