import Link from '@docusaurus/Link';
import shared from '@site/src/components/HomepageShared/styles.module.css';
import type { Rating } from '@site/src/data/solutions';
import {
  ARCHETYPE_LABELS,
  capabilityRows,
  CLUSTERS,
  PINNED_SLUG,
  RATING_COLORS,
  RATING_LABELS,
  solutions,
} from '@site/src/data/solutions';
import Heading from '@theme/Heading';
import clsx from 'clsx';
import type * as React from 'react';

import styles from './styles.module.css';

const ROWS = capabilityRows(solutions);

const BASELINE = ROWS.find((row) => {
  return row.slug === PINNED_SLUG;
});

/* SOAT is rated by the same rubric as every other row, so its own gaps are
   read off the dataset rather than written here. */
const BASELINE_GAPS = (BASELINE?.ratings ?? [])
  .filter((cell) => {
    return cell.rating !== 'native';
  })
  .map((cell) => {
    const label =
      CLUSTERS.find((cluster) => {
        return cluster.id === cell.clusterId;
      })?.label ?? cell.clusterId;
    return `${label} (${RATING_LABELS[cell.rating].toLowerCase()})`;
  });

const RATINGS = Object.keys(RATING_LABELS) as Rating[];

const VERIFIED = ROWS.map((row) => {
  return row.lastVerified;
}).sort();

const VERIFIED_RANGE =
  VERIFIED[0] === VERIFIED[VERIFIED.length - 1]
    ? `on ${VERIFIED[0]}`
    : `between ${VERIFIED[0]} and ${VERIFIED[VERIFIED.length - 1]}`;

const HomepageCompare = (): React.ReactNode => {
  return (
    <section className={clsx(shared.band, styles.section)}>
      <div className="container">
        <div className={shared.header}>
          <p className={shared.eyebrow}>How SOAT compares</p>
          <Heading as="h2" className={shared.title}>
            {ROWS.length - 1} alternatives, one rubric, gaps included.
          </Heading>
          <p className={shared.lead}>
            Every solution is rated on the same {CLUSTERS.length} capability
            clusters from its public documentation, checked {VERIFIED_RANGE}.
            SOAT is rated like the rest, and its own gaps are on the table:{' '}
            {BASELINE_GAPS.join(', ')}.
          </p>
        </div>

        <div className={styles.scroller}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col" className={styles.nameHead}>
                  Solution
                </th>
                <th scope="col" className={styles.textHead}>
                  Type
                </th>
                <th scope="col" className={styles.textHead}>
                  Runs
                </th>
                {CLUSTERS.map((cluster) => {
                  return (
                    <th
                      scope="col"
                      className={styles.clusterHead}
                      key={cluster.id}
                      title={cluster.description}
                    >
                      <span>{cluster.label}</span>
                    </th>
                  );
                })}
                <th scope="col" className={styles.countHead}>
                  Native
                </th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => {
                return (
                  <tr
                    key={row.slug}
                    className={clsx(
                      row.slug === PINNED_SLUG && styles.baselineRow
                    )}
                  >
                    <th scope="row" className={styles.nameCell}>
                      {row.name}
                    </th>
                    <td className={styles.textCell}>
                      {ARCHETYPE_LABELS[row.archetype]}
                    </td>
                    <td className={styles.textCell}>
                      {row.deployment.join(' / ')}
                    </td>
                    {row.ratings.map((cell) => {
                      return (
                        <td className={styles.ratingCell} key={cell.clusterId}>
                          <span
                            className={styles.dot}
                            style={{ background: RATING_COLORS[cell.rating] }}
                            title={RATING_LABELS[cell.rating]}
                          />
                          <span className={styles.srOnly}>
                            {RATING_LABELS[cell.rating]}
                          </span>
                        </td>
                      );
                    })}
                    <td className={styles.countCell}>
                      {row.nativeCount}
                      <span className={styles.countOf}>
                        /{row.ratings.length}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className={styles.footer}>
          <ul className={styles.legend} aria-label="Rating legend">
            {RATINGS.map((rating) => {
              return (
                <li key={rating} className={styles.legendItem}>
                  <span
                    className={styles.dot}
                    style={{ background: RATING_COLORS[rating] }}
                    aria-hidden="true"
                  />
                  {RATING_LABELS[rating]}
                </li>
              );
            })}
          </ul>
          <Link className={styles.more} to="/benchmark">
            Evidence and notes for every rating
            <span aria-hidden="true"> →</span>
          </Link>
        </div>
      </div>
    </section>
  );
};

export default HomepageCompare;
