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
            Every page is server-rendered with its full text in the HTML and has
            a Markdown twin one URL away. The REST surface is one OpenAPI
            description and errors are a catalog of stable codes, so a client
            can be generated without scraping a page.
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
          Send <code>Accept: text/markdown</code> to any documentation URL, or
          append <code>.md</code>, as in{' '}
          <a href="/docs/introduction.md">/docs/introduction.md</a>. A dead URL
          answers a real 404 with a Markdown recovery map.
        </p>
      </div>
    </section>
  );
};

export default HomepageAgentManifest;
