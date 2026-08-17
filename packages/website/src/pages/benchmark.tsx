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

/**
 * Card body. Split out so the card can render as either an interactive control
 * or a plain article without duplicating its contents.
 */
const SolutionCardBody = (props: {
  solution: Solution;
  isPinned: boolean;
  isSelected: boolean;
  selectable: boolean;
}) => {
  const { solution } = props;
  return (
    <>
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
          <span
            className={clsx(
              styles.comparePill,
              props.isSelected && styles.comparePillActive,
              !props.selectable && styles.comparePillMuted
            )}
          >
            {props.isSelected ? 'Remove from comparison' : 'Compare'}
          </span>
        )}
        <Link className={styles.cardLink} to={solution.website}>
          Website
        </Link>
      </div>
    </>
  );
};

/**
 * The `Website` link keeps its own click, so a card-level handler has to ignore
 * anything that came from inside it.
 */
const cameFromLink = (target: EventTarget | null) => {
  return target instanceof Element && target.closest('a') !== null;
};

const TOGGLE_KEYS = new Set(['Enter', ' ', 'Spacebar']);

/**
 * The whole card is the comparison toggle, not just a button inside it. A
 * selectable card therefore *is* a button: it renders as one (rather than an
 * `<article>` wearing `role="button"`, which would claim article semantics it
 * no longer has), takes focus, answers Enter and Space, and reports state
 * through `aria-pressed`. That is also why the pill inside it is a `span` — a
 * real button firing the same action would just be a duplicate tab stop nested
 * in this one.
 *
 * A card that cannot be toggled — the pinned baseline, or any card while the
 * comparison is full — stays a plain `<article>` with no handlers, so it never
 * offers a click that would do nothing.
 */
const SolutionCard = (props: {
  solution: Solution;
  isPinned: boolean;
  isSelected: boolean;
  selectionFull: boolean;
  onToggle: () => void;
}) => {
  const { solution } = props;

  const selectable =
    !props.isPinned && (props.isSelected || !props.selectionFull);

  const className = clsx(
    styles.card,
    props.isPinned && styles.cardPinned,
    selectable && styles.cardSelectable,
    props.isSelected && styles.cardSelected
  );

  const body = (
    <SolutionCardBody
      solution={solution}
      isPinned={props.isPinned}
      isSelected={props.isSelected}
      selectable={selectable}
    />
  );

  if (!selectable) {
    return <article className={className}>{body}</article>;
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (cameFromLink(event.target) || !TOGGLE_KEYS.has(event.key)) {
      return;
    }
    // Space would otherwise scroll the page out from under the card.
    event.preventDefault();
    props.onToggle();
  };

  return (
    <div
      className={className}
      role="button"
      tabIndex={0}
      aria-pressed={props.isSelected}
      aria-label={`${props.isSelected ? 'Remove' : 'Add'} ${solution.name} ${
        props.isSelected ? 'from' : 'to'
      } the comparison`}
      onClick={(event) => {
        if (!cameFromLink(event.target)) {
          props.onToggle();
        }
      }}
      onKeyDown={onKeyDown}
    >
      {body}
    </div>
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
