import { useLocation } from '@docusaurus/router';
import {
  buildNotFoundMarkdown,
  NOT_FOUND_MARKDOWN_HREF,
  RECOVERY_TARGETS,
  resolveMissingPathname,
} from '@site/src/data/agentResources';
import CodeBlock from '@theme/CodeBlock';
import Heading from '@theme/Heading';
import clsx from 'clsx';
import type * as React from 'react';

/**
 * Swizzled from `@docusaurus/theme-classic` (NotFound/Content).
 *
 * A 404 here is a real HTTP 404 (CloudFront serves this page with the 404
 * status), and it carries a recovery map instead of an apology: the handful of
 * URLs — for humans as links, for agents as the same Markdown body served at
 * `/404.md` — that are worth trying next.
 */
export default function NotFoundContent({
  className,
}: {
  className?: string;
}): React.ReactNode {
  const location = useLocation();
  const pathname = resolveMissingPathname({ pathname: location.pathname });

  return (
    <main className={clsx('container margin-vert--xl', className)}>
      <div className="row">
        <div className="col col--8 col--offset-2">
          <Heading as="h1" className="hero__title">
            404 — Page Not Found
          </Heading>
          <p>
            {pathname ? <code>{pathname}</code> : 'That URL'} does not exist on
            this site. The response you are reading is a real HTTP 404, so no
            other path should be inferred from it.
          </p>
          <Heading as="h2">Where to look next</Heading>
          <ul>
            {RECOVERY_TARGETS.map((target) => {
              return (
                <li key={target.href}>
                  <a href={target.href}>{target.label}</a> — {target.hint}
                </li>
              );
            })}
          </ul>
          <p>
            Every documentation page also has a Markdown twin: append{' '}
            <code>.md</code> to its URL, e.g.{' '}
            <a href="/docs/introduction.md">/docs/introduction.md</a>.
          </p>
          <Heading as="h2">Recovery map</Heading>
          <p>
            The same map as Markdown, also served on its own at{' '}
            <a href={NOT_FOUND_MARKDOWN_HREF}>{NOT_FOUND_MARKDOWN_HREF}</a>.
          </p>
          <CodeBlock language="text" title="404.md">
            {buildNotFoundMarkdown({ pathname })}
          </CodeBlock>
        </div>
      </div>
    </main>
  );
}
