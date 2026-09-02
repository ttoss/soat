import Link from '@docusaurus/Link';
import shared from '@site/src/components/HomepageShared/styles.module.css';
import CodeBlock from '@theme/CodeBlock';
import Heading from '@theme/Heading';
import clsx from 'clsx';
import * as React from 'react';

import styles from './styles.module.css';

const TEMPLATE = `resources:
  Provider:
    type: ai_provider
    properties:
      name: openai
      provider: openai
      default_model: gpt-4o
  Docs:
    type: memory
    properties:
      name: product-docs
  Lookup:
    type: tool
    properties:
      name: order-lookup
      type: http
      execute:
        url: https://api.example.com/orders/{order_id}
        method: GET
  Support:
    type: agent
    properties:
      name: support-bot
      ai_provider_id: { ref: Provider }
      knowledge_config:
        memory_ids: [{ ref: Docs }]
      tool_bindings:
        - tool_id: { ref: Lookup }
  Hook:
    type: webhook
    depends_on: [Support]
    properties:
      name: session-events
      url: https://example.com/hooks/soat
      events: ['sessions.*']`;

type GraphNode = {
  id: string;
  type: string;
  round: number;
  x: number;
  y: number;
};

const NODES: GraphNode[] = [
  { id: 'Provider', type: 'ai_provider', round: 1, x: 90, y: 70 },
  { id: 'Docs', type: 'memory', round: 1, x: 90, y: 190 },
  { id: 'Lookup', type: 'tool', round: 1, x: 90, y: 310 },
  { id: 'Support', type: 'agent', round: 2, x: 310, y: 190 },
  { id: 'Hook', type: 'webhook', round: 3, x: 530, y: 190 },
];

const EDGES: Array<[string, string]> = [
  ['Provider', 'Support'],
  ['Docs', 'Support'],
  ['Lookup', 'Support'],
  ['Support', 'Hook'],
];

const NODE_W = 132;
const NODE_H = 52;

const STEPS = [
  {
    title: 'Declare',
    command: 'soat validate-formation',
    detail:
      'One template, JSON or YAML: providers, memories, tools, agents, orchestrations and webhooks. Refs point at logical IDs, not at IDs that exist yet.',
  },
  {
    title: 'Resolve',
    command: 'soat plan-formation',
    detail:
      'SOAT builds the dependency graph from refs and depends_on, rejects cycles, and provisions in topological rounds. Independent resources go in parallel.',
  },
  {
    title: 'Operate',
    command: 'soat list-formation-events',
    detail:
      'Every create, update and delete lands in an immutable event log with the resources it touched and the outputs it produced. A failed deploy rolls back.',
  },
];

/* The graph replays its provisioning order once, when it scrolls into view.
   Server-rendered markup shows the finished state, so a reader without
   JavaScript (or with reduced motion) gets the graph, not a blank panel. The
   phase lives on the element as a class rather than in React state: the effect
   is synchronising the DOM with an observer, not deriving render output. */
const useReplayOnView = (): React.RefObject<HTMLDivElement | null> => {
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return undefined;
    }
    element.classList.add(styles.armed);
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries.some((entry) => {
            return entry.isIntersecting;
          })
        ) {
          element.classList.remove(styles.armed);
          element.classList.add(styles.live);
          observer.disconnect();
        }
      },
      { threshold: 0.45 }
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  return ref;
};

const nodeById = new Map(
  NODES.map((node) => {
    return [node.id, node];
  })
);

const DependencyGraph = () => {
  const ref = useReplayOnView();

  return (
    <div
      ref={ref}
      className={styles.graph}
      aria-label="Dependency graph: Provider, Docs and Lookup are provisioned in round one, Support in round two, Hook in round three."
      role="img"
    >
      <svg viewBox="0 0 640 380" className={styles.graphSvg}>
        <defs>
          <marker
            id="soat-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L10 5 L0 10 z" fill="#00e5ff" />
          </marker>
        </defs>

        {[1, 2, 3].map((round) => {
          const x =
            NODES.find((node) => {
              return node.round === round;
            })?.x ?? 0;
          return (
            <g key={round}>
              <line
                className={styles.roundLine}
                x1={x}
                y1={20}
                x2={x}
                y2={352}
              />
              <text
                className={styles.roundLabel}
                x={x}
                y={372}
                textAnchor="middle"
              >
                round {round}
              </text>
            </g>
          );
        })}

        {EDGES.map(([from, to]) => {
          const a = nodeById.get(from);
          const b = nodeById.get(to);
          if (!a || !b) return null;
          const x1 = a.x + NODE_W / 2;
          const x2 = b.x - NODE_W / 2;
          const midX = (x1 + x2) / 2;
          const d = `M${x1},${a.y} C${midX},${a.y} ${midX},${b.y} ${x2},${b.y}`;
          return (
            <path
              key={`${from}-${to}`}
              className={styles.edge}
              style={{ animationDelay: `${a.round * 0.55}s` }}
              d={d}
              markerEnd="url(#soat-arrow)"
            />
          );
        })}

        {NODES.map((node) => {
          return (
            <g
              key={node.id}
              className={clsx(
                styles.node,
                node.round === 2 && styles.nodeAgent
              )}
              style={{ animationDelay: `${(node.round - 1) * 0.55}s` }}
            >
              <rect
                x={node.x - NODE_W / 2}
                y={node.y - NODE_H / 2}
                width={NODE_W}
                height={NODE_H}
                rx="8"
              />
              <text
                className={styles.nodeId}
                x={node.x}
                y={node.y - 4}
                textAnchor="middle"
              >
                {node.id}
              </text>
              <text
                className={styles.nodeType}
                x={node.x}
                y={node.y + 14}
                textAnchor="middle"
              >
                {node.type}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
};

const HomepageFormations = (): React.ReactNode => {
  return (
    <section
      className={clsx(shared.band, shared.bleed, shared.dark, styles.section)}
    >
      <div className="container">
        <div className={shared.header}>
          <p className={shared.eyebrow}>Agent formations</p>
          <Heading as="h2" className={shared.title}>
            Deploy a whole agent stack from one template.
          </Heading>
          <p className={shared.lead}>
            Formations are the declarative layer. Describe the stack once,
            preview the plan, and SOAT creates or updates every dependent
            resource in the right order, with the same permissions and the same
            traceable operations as a hand-made call.{' '}
            <Link to="/docs/modules/formations">Formations docs</Link>.
          </p>
        </div>

        <div className={styles.pair}>
          <div className={styles.template}>
            <CodeBlock language="yaml" title="support-stack.yaml">
              {TEMPLATE}
            </CodeBlock>
          </div>
          <div className={styles.graphColumn}>
            <p className={styles.graphCaption}>
              <span className={shared.mono}>plan-formation</span> resolves the
              template into this graph.
            </p>
            <DependencyGraph />
          </div>
        </div>

        <ol className={styles.rail}>
          {STEPS.map((step, index) => {
            return (
              <li className={styles.station} key={step.title}>
                <span className={styles.stationDot} aria-hidden="true" />
                <span className={styles.stationIndex}>
                  {String(index + 1).padStart(2, '0')}
                </span>
                <Heading as="h3" className={styles.stationTitle}>
                  {step.title}
                </Heading>
                <code className={styles.stationCommand}>{step.command}</code>
                <p className={styles.stationDetail}>{step.detail}</p>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
};

export default HomepageFormations;
