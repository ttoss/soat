import Link from '@docusaurus/Link';
import shared from '@site/src/components/HomepageShared/styles.module.css';
import CodeBlock from '@theme/CodeBlock';
import Heading from '@theme/Heading';
import clsx from 'clsx';
import * as React from 'react';

import styles from './styles.module.css';

type Surface = {
  id: string;
  name: string;
  bestFor: string;
  href: string;
  language: string;
  title: string;
  code: string;
  icon: React.ReactNode;
};

const IconRestApi = () => {
  return (
    <svg viewBox="0 0 48 48" className={styles.icon} aria-hidden="true">
      <rect
        x="4"
        y="10"
        width="40"
        height="28"
        rx="4"
        stroke="currentColor"
        strokeWidth="2.5"
        fill="none"
      />
      <path
        d="M12 24h24M12 18h16M12 30h20"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="38" cy="18" r="2" fill="currentColor" opacity="0.6" />
    </svg>
  );
};

const IconMcp = () => {
  return (
    <svg viewBox="0 0 48 48" className={styles.icon} aria-hidden="true">
      <circle
        cx="24"
        cy="24"
        r="10"
        stroke="currentColor"
        strokeWidth="2.5"
        fill="none"
      />
      <circle cx="24" cy="24" r="3" fill="currentColor" opacity="0.7" />
      <path
        d="M24 4v10M24 34v10M4 24h10M34 24h10"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
};

const IconCli = () => {
  return (
    <svg viewBox="0 0 48 48" className={styles.icon} aria-hidden="true">
      <rect
        x="4"
        y="8"
        width="40"
        height="32"
        rx="4"
        stroke="currentColor"
        strokeWidth="2.5"
        fill="none"
      />
      <polyline
        points="12,22 18,28 12,34"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <line
        x1="22"
        y1="34"
        x2="34"
        y2="34"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
};

const IconSdk = () => {
  return (
    <svg viewBox="0 0 48 48" className={styles.icon} aria-hidden="true">
      <polyline
        points="16,14 6,24 16,34"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <polyline
        points="32,14 42,24 32,34"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <line
        x1="28"
        y1="10"
        x2="20"
        y2="38"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
};

const SURFACES: Surface[] = [
  {
    id: 'rest',
    name: 'REST API',
    bestFor: 'Backend services in any language',
    href: '/docs/api',
    language: 'bash',
    title: 'POST /api/v1/agents',
    code: `curl -X POST http://localhost:5047/api/v1/agents \\
  -H "Authorization: Bearer sk_..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "project_id": "proj_01HXYZ",
    "ai_provider_id": "aip_01HXYZ",
    "name": "support-bot",
    "instructions": "You are a helpful support assistant."
  }'`,
    icon: <IconRestApi />,
  },
  {
    id: 'mcp',
    name: 'MCP server',
    bestFor: 'Claude Desktop, Cursor, VS Code, any MCP runtime',
    href: '/docs/mcp',
    language: 'json',
    title: 'tools/call → create-agent',
    code: `{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "create-agent",
    "arguments": {
      "project_id": "proj_01HXYZ",
      "ai_provider_id": "aip_01HXYZ",
      "name": "support-bot",
      "instructions": "You are a helpful support assistant."
    }
  }
}`,
    icon: <IconMcp />,
  },
  {
    id: 'cli',
    name: 'CLI',
    bestFor: 'Scripts, CI pipelines, local exploration',
    href: '/docs/cli',
    language: 'bash',
    title: 'soat create-agent',
    code: `soat create-agent \\
  --project-id proj_01HXYZ \\
  --ai-provider-id aip_01HXYZ \\
  --name support-bot \\
  --instructions "You are a helpful support assistant."`,
    icon: <IconCli />,
  },
  {
    id: 'sdk',
    name: 'TypeScript SDK',
    bestFor: 'TypeScript and JavaScript applications',
    href: '/docs/sdk',
    language: 'ts',
    title: 'soat.agents.createAgent',
    code: `import { SoatClient } from '@soat/sdk';

const soat = new SoatClient({
  baseUrl: 'http://localhost:5047',
  token: 'sk_...',
});

const { data: agent } = await soat.agents.createAgent({
  body: {
    project_id: 'proj_01HXYZ',
    ai_provider_id: 'aip_01HXYZ',
    name: 'support-bot',
    instructions: 'You are a helpful support assistant.',
  },
});`,
    icon: <IconSdk />,
  },
];

const IDENTICAL = [
  { label: 'Authentication', value: 'one sk_ key or user JWT' },
  { label: 'Permission', value: 'agents:CreateAgent' },
  { label: 'Data', value: 'one PostgreSQL database' },
  { label: 'Contract', value: 'one OpenAPI document' },
];

const HomepageSurfaces = (): React.ReactNode => {
  const [active, setActive] = React.useState(SURFACES[0].id);

  return (
    <section className={clsx(shared.band, styles.section)}>
      <div className="container">
        <div className={clsx(shared.header, styles.header)}>
          <p className={shared.eyebrow}>Client surfaces</p>
          <Heading as="h2" className={shared.title}>
            One backend. Four ways to call it.
          </Heading>
          <p className={shared.lead}>
            The CLI, the SDK and the MCP tool surface are generated from the
            same OpenAPI documents the REST API is described by, so an operation
            that exists on one surface exists on all four. Pick the one that
            fits where your code runs. This is the same call, four times.
          </p>
        </div>

        <div className={styles.switcher}>
          <div
            className={styles.tabs}
            role="tablist"
            aria-label="Client surface"
          >
            {SURFACES.map((surface) => {
              const selected = surface.id === active;
              return (
                <button
                  key={surface.id}
                  type="button"
                  role="tab"
                  id={`surface-tab-${surface.id}`}
                  aria-selected={selected}
                  aria-controls={`surface-panel-${surface.id}`}
                  className={clsx(styles.tab, selected && styles.tabActive)}
                  onClick={() => {
                    setActive(surface.id);
                  }}
                >
                  {surface.icon}
                  <span className={styles.tabText}>
                    <span className={styles.tabName}>{surface.name}</span>
                    <span className={styles.tabBestFor}>{surface.bestFor}</span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className={styles.panels}>
            {SURFACES.map((surface) => {
              const selected = surface.id === active;
              return (
                <div
                  key={surface.id}
                  role="tabpanel"
                  id={`surface-panel-${surface.id}`}
                  aria-labelledby={`surface-tab-${surface.id}`}
                  hidden={!selected}
                  className={styles.panel}
                >
                  <CodeBlock language={surface.language} title={surface.title}>
                    {surface.code}
                  </CodeBlock>
                  <Link className={styles.panelLink} to={surface.href}>
                    {surface.name} docs
                    <span aria-hidden="true"> →</span>
                  </Link>
                </div>
              );
            })}
          </div>
        </div>

        <dl className={styles.identical}>
          {IDENTICAL.map((fact) => {
            return (
              <div className={styles.identicalItem} key={fact.label}>
                <dt>{fact.label}</dt>
                <dd className={shared.mono}>{fact.value}</dd>
              </div>
            );
          })}
        </dl>
      </div>
    </section>
  );
};

export default HomepageSurfaces;
