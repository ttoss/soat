import shared from '@site/src/components/HomepageShared/styles.module.css';
import { AGENT_RESOURCES } from '@site/src/data/agentResources';
import Heading from '@theme/Heading';
import clsx from 'clsx';
import type * as React from 'react';

import styles from './styles.module.css';

const HomepageAgentManifest = (): React.ReactNode => {
  return (
    <section className={clsx(shared.band, styles.section)}>
      <div className="container">
        <div className={shared.header}>
          <p className={shared.eyebrow}>Built for agents</p>
          <Heading as="h2" className={shared.title}>
            Everything on this site is readable by a machine.
          </Heading>
          <p className={shared.lead}>
            SOAT is infrastructure for agents, so its documentation is published
            the way an agent wants to read it. Every page is server-rendered,
            with the full text in the HTML and no JavaScript required, and has a
            Markdown twin one URL away. The REST surface is one OpenAPI
            description and the error contract is a catalog of stable codes, so
            a client can be generated and its failures handled without scraping
            a page.
          </p>
        </div>

        <div className={styles.listing}>
          <div className={styles.listingHead}>
            <span className={styles.listingCommand}>
              <span className={styles.prompt} aria-hidden="true">
                $
              </span>
              curl -H &quot;Accept: text/markdown&quot; https://soat.ttoss.dev/
            </span>
            <span className={styles.listingCount}>
              {AGENT_RESOURCES.length} entries
            </span>
          </div>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">path</th>
                <th scope="col">type</th>
                <th scope="col">what an agent gets</th>
              </tr>
            </thead>
            <tbody>
              {AGENT_RESOURCES.map((resource) => {
                return (
                  <tr key={resource.href}>
                    <td className={styles.pathCell}>
                      <a href={resource.href}>{resource.href}</a>
                    </td>
                    <td className={styles.typeCell}>
                      <span className={styles.type}>{resource.mediaType}</span>
                    </td>
                    <td className={styles.descriptionCell}>
                      {resource.description}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className={styles.note}>
          Send <code>Accept: text/markdown</code> to any documentation URL and
          that page answers in Markdown, or append <code>.md</code> for the same
          file by name, for example{' '}
          <a href="/docs/introduction.md">/docs/introduction.md</a>. Every HTML
          page advertises its own twin with a{' '}
          <code>
            &lt;link rel=&quot;alternate&quot;
            type=&quot;text/markdown&quot;&gt;
          </code>{' '}
          tag, and dead URLs answer with a real HTTP 404 carrying a Markdown
          recovery map instead of a soft 200.
        </p>
      </div>
    </section>
  );
};

export default HomepageAgentManifest;
