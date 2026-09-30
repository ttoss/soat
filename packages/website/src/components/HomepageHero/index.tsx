import Link from '@docusaurus/Link';
import PrimaryAction from '@site/src/components/HomepageShared/PrimaryAction';
import shared from '@site/src/components/HomepageShared/styles.module.css';
import HomepageTerminal from '@site/src/components/HomepageTerminal';
import { HERO } from '@site/src/data/homepage';
import Heading from '@theme/Heading';
import clsx from 'clsx';
import type * as React from 'react';

import packageJson from '../../../package.json';
import styles from './styles.module.css';

/* Every package is versioned together (`forcePublish` in lerna.json), so the
   site's own version is the release a reader would install. */
const RELEASE = `v${packageJson.version}`;

const FACTS = [
  {
    value: 'Apache 2.0',
    label: 'licensed, nothing withheld',
    href: 'https://github.com/ttoss/soat/blob/main/LICENSE',
  },
  {
    value: '1 process',
    label: 'Node.js on PostgreSQL + pgvector',
    href: '/docs/self-hosting/configuration',
  },
  {
    value: '4 surfaces',
    label: 'REST, MCP, CLI, SDK from one OpenAPI document',
    href: '/docs/client-surfaces',
  },
  {
    value: RELEASE,
    label: 'latest release, pre-1.0',
    href: `https://github.com/ttoss/soat/releases/tag/${RELEASE}`,
  },
];

const HomepageHero = (): React.ReactNode => {
  return (
    <header className={clsx(shared.bleed, styles.hero)}>
      <div className={clsx('container', styles.inner)}>
        <div className={styles.copy}>
          <p className={clsx(shared.eyebrow, styles.eyebrow)}>
            Open source · Self-hosted
          </p>
          <Heading as="h1" className={styles.title}>
            {HERO.title}{' '}
            <span className={styles.emphasis}>{HERO.emphasis}</span>
          </Heading>
          <p className={styles.subtitle}>{HERO.subtitle}</p>
          <div className={styles.actions}>
            <PrimaryAction />
            <Link
              className={shared.ghostButton}
              to="https://github.com/ttoss/soat"
            >
              Star on GitHub
            </Link>
          </div>
          <p className={styles.command}>
            <span className={styles.prompt} aria-hidden="true">
              $
            </span>
            <code>docker compose up -d</code>
            <span className={styles.commandHint}>
              with the{' '}
              <Link to="/docs/getting-started#1-create-a-docker-compose-file">
                quick start&apos;s Compose file
              </Link>
              : PostgreSQL, Ollama and the server, offline.
            </span>
          </p>
        </div>
        <div className={styles.visual}>
          <HomepageTerminal />
        </div>
      </div>
      <dl className={clsx('container', styles.facts)}>
        {FACTS.map((fact) => {
          return (
            <div className={styles.fact} key={fact.label}>
              <dt className={styles.factValue}>
                <Link to={fact.href}>{fact.value}</Link>
              </dt>
              <dd className={styles.factLabel}>{fact.label}</dd>
            </div>
          );
        })}
      </dl>
    </header>
  );
};

export default HomepageHero;
