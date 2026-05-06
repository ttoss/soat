import Heading from '@theme/Heading';
import clsx from 'clsx';
import type * as React from 'react';

import styles from './styles.module.css';

type FeatureItem = {
  title: string;
  Svg: React.ComponentType<React.ComponentProps<'svg'>>;
  description: React.ReactNode;
};

const FeatureList: FeatureItem[] = [
  {
    title: 'Everything Your AI App Needs',
    Svg: require('@site/static/img/soat-complete-backend.svg').default,
    description: (
      <>
        IAM, projects, API keys, files, vector search, secrets, webhooks, and
        traces — a single PostgreSQL-backed server replaces a stack of services.
      </>
    ),
  },
  {
    title: 'Agents, Sessions & RAG',
    Svg: require('@site/static/img/soat-agent-orchestration.svg').default,
    description: (
      <>
        Tool-calling agents, multi-agent workflows, async generations, and
        memory-driven retrieval. Two API calls take a user from message to
        answer.
      </>
    ),
  },
  {
    title: 'MCP, REST, CLI & SDK',
    Svg: require('@site/static/img/soat-mcp-native.svg').default,
    description: (
      <>
        Every operation is reachable through four equivalent surfaces. Plug SOAT
        into Claude Desktop, your backend, your scripts, or your TypeScript app.
      </>
    ),
  },
];

const Feature = ({ title, Svg, description }: FeatureItem) => {
  return (
    <div className={clsx('col col--4')}>
      <div className="text--center">
        <Svg className={styles.featureSvg} role="img" />
      </div>
      <div className="text--center padding-horiz--md">
        <Heading as="h3">{title}</Heading>
        <p>{description}</p>
      </div>
    </div>
  );
};

export default function HomepageFeatures(): React.ReactNode {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className="row">
          {FeatureList.map((props, idx) => {
            return <Feature key={idx} {...props} />;
          })}
        </div>
      </div>
    </section>
  );
}
