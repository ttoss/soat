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
    title: 'Persistent Memory',
    Svg: require('@site/static/img/undraw_docusaurus_mountain.svg').default,
    description: (
      <>
        Give your AI agents a long-term memory that persists across sessions.
        Store text, files, and context that stays available forever.
      </>
    ),
  },
  {
    title: 'Semantic Search',
    Svg: require('@site/static/img/undraw_docusaurus_tree.svg').default,
    description: (
      <>
        Retrieve relevant information instantly. SOAT uses advanced vector
        embeddings to understand the meaning of your data, not just keywords.
      </>
    ),
  },
  {
    title: 'MCP Native',
    Svg: require('@site/static/img/undraw_docusaurus_react.svg').default,
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
