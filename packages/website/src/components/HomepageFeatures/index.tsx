import Heading from '@theme/Heading';
import clsx from 'clsx';
import type * as React from 'react';

import styles from './styles.module.css';

type FeatureItem = {
  title: string;
  Svg: React.ComponentType<React.ComponentProps<'svg'>>;
  description: ReactNode;
};

const FeatureList: FeatureItem[] = [
  {
    title: 'Complete Backend',
    Svg: require('@site/static/img/soat-complete-backend.svg').default,
    description: (
      <>
        IAM, document and file storage with vector search, conversational
        memory, secrets management, and webhooks — everything your AI app needs
        in one server.
      </>
    ),
  },
  {
    title: 'Agent Orchestration',
    Svg: require('@site/static/img/soat-agent-orchestration.svg').default,
    description: (
      <>
        Run agents with tool calling, multi-turn conversations, and pluggable AI
        providers. SOAT manages the full lifecycle so you can focus on your
        product.
      </>
    ),
  },
  {
    title: 'MCP Native',
    Svg: require('@site/static/img/soat-mcp-native.svg').default,
    description: (
      <>
        Plug-and-play compatibility with the Model Context Protocol. Connect
        effortlessly to Claude Desktop, Cursor, and other AI tools.
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

export default function HomepageFeatures(): ReactNode {
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
