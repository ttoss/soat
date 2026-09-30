import Link from '@docusaurus/Link';
import shared from '@site/src/components/HomepageShared/styles.module.css';
import { NOT_WIRED } from '@site/src/data/homepage';
import Heading from '@theme/Heading';
import clsx from 'clsx';
import type * as React from 'react';

import styles from './styles.module.css';

const CALLERS = [
  { label: 'Backend', via: 'REST /api/v1' },
  { label: 'Claude, Cursor, VS Code', via: 'MCP /mcp' },
  { label: 'CI and scripts', via: 'soat CLI' },
  { label: 'TypeScript app', via: '@soat/sdk' },
  { label: 'Browser', via: 'web app /app' },
];

const MODULE_GROUPS = [
  {
    name: 'Identity & access',
    modules: ['users', 'projects', 'iam', 'api-keys', 'oauth'],
  },
  {
    name: 'Storage & retrieval',
    modules: ['files', 'documents', 'knowledge', 'memories', 'ingestion-rules'],
  },
  {
    name: 'Agents',
    modules: ['agents', 'sessions', 'conversations', 'tools', 'chats'],
  },
  {
    name: 'Orchestration',
    modules: ['orchestrations', 'workflows', 'triggers', 'formations'],
  },
  {
    name: 'Governance',
    modules: ['guardrails', 'approvals', 'quotas', 'usage', 'evaluations'],
  },
  {
    name: 'Operations',
    modules: ['traces', 'exceptions', 'audit-log', 'webhooks', 'secrets'],
  },
];

const HomepageDefinition = (): React.ReactNode => {
  return (
    <section className={clsx(shared.band, styles.section)}>
      <div className="container">
        <div className={styles.grid}>
          <div className={styles.intro}>
            <p className={shared.eyebrow}>How a call flows</p>
            <Heading as="h2" className={shared.title}>
              Every caller reaches the same logic through the same permissions.
            </Heading>
            <p className={shared.lead}>
              SOAT is open-source infrastructure for production-ready AI agents.
              You bring the product; SOAT handles the layer underneath it.
            </p>
            <p className={clsx(shared.lead, styles.leadSecond)}>
              The REST API and the MCP endpoint are one Node.js process calling
              the same business logic through the same permission engine, so a
              resource created on one surface is already visible on the others.
              The server and its PostgreSQL database are the whole stack. Each
              module below links to its documentation.
            </p>
            <p className={styles.notWired}>
              <span className={styles.notWiredLabel}>Nothing else to run:</span>
              {NOT_WIRED.map((item) => {
                return (
                  <s className={styles.struck} key={item}>
                    {item}
                  </s>
                );
              })}
            </p>
          </div>

          <div
            className={styles.diagram}
            aria-label="How a call flows through SOAT"
          >
            <div className={styles.callers}>
              <p className={styles.laneTitle}>Callers</p>
              {CALLERS.map((caller) => {
                return (
                  <div className={styles.caller} key={caller.label}>
                    <span className={styles.callerLabel}>{caller.label}</span>
                    <span className={clsx(shared.mono, styles.callerVia)}>
                      {caller.via}
                    </span>
                  </div>
                );
              })}
            </div>

            <div className={styles.server}>
              <div className={styles.serverHead}>
                <span className={styles.serverName}>SOAT server</span>
                <span className={clsx(shared.mono, styles.serverMeta)}>
                  one Node.js process · :5047
                </span>
              </div>
              <div className={styles.ports}>
                <span className={clsx(shared.mono, styles.port)}>
                  REST /api/v1
                </span>
                <span className={clsx(shared.mono, styles.port)}>MCP /mcp</span>
              </div>
              <div className={styles.engine}>
                <span>Business logic</span>
                <span className={styles.enginePlus} aria-hidden="true">
                  +
                </span>
                <span>Permission engine</span>
              </div>
              <div className={styles.groups}>
                {MODULE_GROUPS.map((group) => {
                  return (
                    <div className={styles.group} key={group.name}>
                      <span className={styles.groupName}>{group.name}</span>
                      <span className={styles.chips}>
                        {group.modules.map((module) => {
                          return (
                            <Link
                              className={clsx(shared.mono, styles.chip)}
                              to={`/docs/modules/${module}`}
                              key={module}
                            >
                              {module}
                            </Link>
                          );
                        })}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className={styles.store}>
              <p className={styles.laneTitle}>State</p>
              <div className={styles.database}>
                <span className={styles.databaseName}>PostgreSQL</span>
                <span className={clsx(shared.mono, styles.databaseTag)}>
                  + pgvector
                </span>
                <ul className={styles.databaseList}>
                  <li>rows and files</li>
                  <li>embeddings</li>
                  <li>message history</li>
                  <li>traces and audit log</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default HomepageDefinition;
