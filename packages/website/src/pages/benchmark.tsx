import Link from '@docusaurus/Link';
import Heading from '@theme/Heading';
import Layout from '@theme/Layout';
import clsx from 'clsx';
import * as React from 'react';

import type { Archetype, Rating, Solution } from '../data/solutions';
import {
  ARCHETYPE_LABELS,
  CLUSTERS,
  orderSolutions,
  PINNED_SLUG,
  RATING_LABELS,
  solutions,
} from '../data/solutions';
import styles from './benchmark.module.css';

const MAX_COMPARED = 4;

const RATING_COLORS: Record<Rating, string> = {
  native: 'var(--ifm-color-success)',
  partial: 'var(--ifm-color-warning)',
  plugin: 'var(--soat-violet, #8e44ad)',
  absent: 'var(--ifm-color-emphasis-400)',
};

const RatingBadge = (props: { rating: Rating }) => {
  const color = RATING_COLORS[props.rating];
  return (
    <span
      className={styles.ratingBadge}
      style={{
        color,
        borderColor: `color-mix(in srgb, ${color} 50%, transparent)`,
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
      }}
    >
      {RATING_LABELS[props.rating]}
    </span>
  );
};

const SolutionCard = (props: {
  solution: Solution;
  isPinned: boolean;
  isSelected: boolean;
  selectionFull: boolean;
  onToggle: () => void;
}) => {
  const { solution } = props;
  return (
    <article className={clsx(styles.card, props.isPinned && styles.cardPinned)}>
      {props.isPinned ? <p className={styles.baselineTag}>Baseline</p> : null}
      <div className={styles.cardHead}>
        <Heading as="h3" className={styles.cardTitle}>
          {solution.name}
        </Heading>
        <span className={styles.archetypeBadge}>
          {ARCHETYPE_LABELS[solution.archetype]}
        </span>
      </div>
      <div className={styles.cardMeta}>
        {solution.license} · {solution.deployment.join(' / ')} · verified{' '}
        {solution.last_verified}
      </div>
      <p className={styles.cardSummary}>{solution.summary}</p>
      <div className={styles.dotRow}>
        {CLUSTERS.map((cluster) => {
          const capability = solution.capabilities[cluster.id];
          return (
            <span
              key={cluster.id}
              className={styles.dot}
              title={`${cluster.label}: ${RATING_LABELS[capability.rating]}`}
              style={{ background: RATING_COLORS[capability.rating] }}
            />
          );
        })}
      </div>
      <div className={styles.cardActions}>
        {props.isPinned ? (
          <span className={styles.pinnedNote}>
            Pinned as the comparison baseline
          </span>
        ) : (
          <button
            type="button"
            className={clsx(
              styles.compareButton,
              props.isSelected && styles.compareButtonActive
            )}
            disabled={!props.isSelected && props.selectionFull}
            onClick={props.onToggle}
          >
            {props.isSelected ? 'Remove from comparison' : 'Compare'}
          </button>
        )}
        <Link className={styles.cardLink} to={solution.website}>
          Website
        </Link>
      </div>
    </article>
  );
};

const ComparatorMatrix = (props: { compared: Solution[] }) => {
  return (
    <section className={styles.comparator}>
      <Heading as="h2">Capability comparison</Heading>
      <div className={styles.tableWrap}>
        <table className={styles.matrix}>
          <thead>
            <tr>
              <th className={styles.clusterCell}>Capability cluster</th>
              {props.compared.map((solution) => {
                return <th key={solution.slug}>{solution.name}</th>;
              })}
            </tr>
          </thead>
          <tbody>
            {CLUSTERS.map((cluster) => {
              return (
                <tr key={cluster.id}>
                  <th className={styles.clusterCell}>
                    <span className={styles.clusterName}>{cluster.label}</span>
                    <span className={styles.clusterDescription}>
                      {cluster.description}
                    </span>
                  </th>
                  {props.compared.map((solution) => {
                    const capability = solution.capabilities[cluster.id];
                    return (
                      <td key={solution.slug}>
                        <RatingBadge rating={capability.rating} />
                        <span className={styles.cellNote}>
                          {capability.note}
                        </span>
                        {capability.evidence ? (
                          <Link
                            className={styles.evidenceLink}
                            to={capability.evidence}
                          >
                            Source
                          </Link>
                        ) : null}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className={styles.legend}>
        {(Object.keys(RATING_LABELS) as Rating[]).map((rating) => {
          return (
            <span key={rating} className={styles.legendItem}>
              <span
                className={styles.dot}
                style={{ background: RATING_COLORS[rating] }}
              />
              {RATING_LABELS[rating]}
            </span>
          );
        })}
      </div>
    </section>
  );
};

const DirectoryControls = (props: {
  query: string;
  onQueryChange: (value: string) => void;
  archetype: Archetype | 'all';
  onArchetypeChange: (value: Archetype | 'all') => void;
  cluster: string;
  onClusterChange: (value: string) => void;
}) => {
  return (
    <div className={styles.controls}>
      <input
        className={styles.search}
        type="search"
        placeholder="Search solutions…"
        value={props.query}
        onChange={(event) => {
          props.onQueryChange(event.target.value);
        }}
      />
      <div className={styles.chipRow}>
        {(
          ['all', 'managed-platform', 'framework', 'infrastructure'] as const
        ).map((value) => {
          return (
            <button
              key={value}
              type="button"
              className={clsx(
                styles.chip,
                props.archetype === value && styles.chipActive
              )}
              onClick={() => {
                props.onArchetypeChange(value);
              }}
            >
              {value === 'all' ? 'All archetypes' : ARCHETYPE_LABELS[value]}
            </button>
          );
        })}
      </div>
      <select
        className={styles.clusterSelect}
        value={props.cluster}
        onChange={(event) => {
          props.onClusterChange(event.target.value);
        }}
        aria-label="Filter by capability cluster"
      >
        <option value="all">Any capability</option>
        {CLUSTERS.map((entry) => {
          return (
            <option key={entry.id} value={entry.id}>
              Covers: {entry.label}
            </option>
          );
        })}
      </select>
    </div>
  );
};

export default function Benchmark(): React.ReactNode {
  const [query, setQuery] = React.useState('');
  const [archetype, setArchetype] = React.useState<Archetype | 'all'>('all');
  const [cluster, setCluster] = React.useState<string>('all');
  const [selected, setSelected] = React.useState<string[]>([]);

  const pinned = solutions.find((solution) => {
    return solution.slug === PINNED_SLUG;
  });

  const filtered = orderSolutions(solutions).filter((solution) => {
    if (archetype !== 'all' && solution.archetype !== archetype) {
      return false;
    }
    if (cluster !== 'all') {
      const rating = solution.capabilities[cluster].rating;
      if (rating !== 'native' && rating !== 'partial') {
        return false;
      }
    }
    if (query.trim()) {
      const haystack = `${solution.name} ${solution.summary}`.toLowerCase();
      if (!haystack.includes(query.trim().toLowerCase())) {
        return false;
      }
    }
    return true;
  });

  const toggleSelected = (slug: string) => {
    setSelected((current) => {
      if (current.includes(slug)) {
        return current.filter((entry) => {
          return entry !== slug;
        });
      }
      if (current.length >= MAX_COMPARED) {
        return current;
      }
      return [...current, slug];
    });
  };

  const compared = orderSolutions([
    ...(pinned ? [pinned] : []),
    ...selected
      .map((slug) => {
        return solutions.find((solution) => {
          return solution.slug === slug;
        });
      })
      .filter((solution): solution is Solution => {
        return Boolean(solution);
      }),
  ]);

  return (
    <Layout
      title="Benchmark — How SOAT compares"
      description="A clustered directory of AI agent platforms, frameworks, and infrastructure — filter the landscape, then compare capability coverage side by side with SOAT."
    >
      <main className="container">
        <header className={styles.header}>
          <p className={styles.eyebrow}>Agent platform landscape</p>
          <Heading as="h1">How SOAT compares.</Heading>
          <p className={styles.lead}>
            Solutions are clustered by archetype — managed platforms, agent
            frameworks, and infrastructure layers — and rated across{' '}
            {CLUSTERS.length} capability clusters. Filter the directory, pick up
            to {MAX_COMPARED} solutions, and compare them side by side with
            SOAT.
          </p>
        </header>

        <DirectoryControls
          query={query}
          onQueryChange={setQuery}
          archetype={archetype}
          onArchetypeChange={setArchetype}
          cluster={cluster}
          onClusterChange={setCluster}
        />

        <p className={styles.resultCount}>
          {filtered.length} of {solutions.length} solutions
        </p>

        <div className={styles.grid}>
          {filtered.map((solution) => {
            return (
              <SolutionCard
                key={solution.slug}
                solution={solution}
                isPinned={solution.slug === PINNED_SLUG}
                isSelected={selected.includes(solution.slug)}
                selectionFull={selected.length >= MAX_COMPARED}
                onToggle={() => {
                  toggleSelected(solution.slug);
                }}
              />
            );
          })}
        </div>

        <ComparatorMatrix compared={compared} />

        <section className={styles.methodology}>
          <Heading as="h2">Methodology</Heading>
          <p>
            Each solution is rated per capability cluster: <em>Native</em>{' '}
            (built into the product), <em>Partial</em> (covered with significant
            caveats or by adjacent services), <em>Via plugin</em> (possible
            through the solution&apos;s extension system), or <em>Absent</em>.
            Every non-absent rating links to its source, and every entry carries
            a verification date. Ratings compare product scope, not quality — a
            framework is not worse for delegating governance; it is a different
            archetype.
          </p>
          <p>
            Spotted an outdated claim, or want a solution added? Open a pull
            request against{' '}
            <Link to="https://github.com/ttoss/soat">ttoss/soat</Link> — each
            solution is one JSON file under{' '}
            <code>packages/website/src/data/solutions/</code>, validated in CI.
          </p>
        </section>
      </main>
    </Layout>
  );
}
