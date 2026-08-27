/**
 * The entity metadata this site puts in every page's `<head>`: the crawl
 * directives, and the JSON-LD that ties the name "SOAT" to one thing.
 *
 * Extracted from `docusaurus.config.ts` so the config stays readable — the
 * structured data is content, and it belongs beside the other content
 * declarations in `src/data`.
 *
 * "SOAT" collides with the mandatory vehicle-insurance scheme in Colombia, Peru
 * and Ecuador and with the SOAT1/SOAT2 enzymes, so the qualifying words are what
 * make the project resolvable at all — and they only consolidate onto one entity
 * if every property repeats them verbatim.
 */

import type { Config } from '@docusaurus/types';

export const HEAD_TAGS: Config['headTags'] = [
  {
    // Lift Google's default snippet cap so full passages are eligible to
    // ground AI Overviews / AI Mode answers (and regular rich snippets).
    tagName: 'meta',
    attributes: {
      name: 'robots',
      content: 'max-snippet:-1, max-image-preview:large',
    },
  },
  {
    // og:type is the one entity-resolution signal Docusaurus does not emit
    // itself. `checkAgentSurfaces` fails the build if it stops being emitted.
    tagName: 'meta',
    attributes: {
      property: 'og:type',
      content: 'website',
    },
  },
  {
    // Ties a search for "SOAT" to this domain rather than the many unrelated
    // things spelled the same way: `alternateName` carries the qualified forms
    // people type, `sameAs` the profiles that corroborate the name.
    tagName: 'script',
    attributes: { type: 'application/ld+json' },
    innerHTML: JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      '@id': 'https://soat.ttoss.dev/#website',
      name: 'SOAT',
      alternateName: [
        'SOAT by ttoss',
        'ttoss SOAT',
        'SOAT AI agent infrastructure',
      ],
      url: 'https://soat.ttoss.dev',
      description:
        'Documentation for SOAT — open-source infrastructure for production-ready AI agents.',
      inLanguage: 'en',
      publisher: { '@id': 'https://ttoss.dev/#organization' },
    }),
  },
  {
    tagName: 'script',
    attributes: { type: 'application/ld+json' },
    innerHTML: JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Organization',
      '@id': 'https://ttoss.dev/#organization',
      name: 'Terezinha Tech Operations',
      alternateName: 'ttoss',
      url: 'https://ttoss.dev',
      logo: 'https://soat.ttoss.dev/img/soat-logo.png',
      sameAs: [
        'https://github.com/ttoss',
        'https://github.com/ttoss/soat',
        'https://www.npmjs.com/org/soat',
      ],
      // A public URL rather than an address or phone number: SOAT is
      // self-hosted software developed in the open, with no support desk to
      // route a caller to.
      contactPoint: [
        {
          '@type': 'ContactPoint',
          contactType: 'technical support',
          url: 'https://soat.ttoss.dev/contact',
          availableLanguage: ['English'],
        },
        {
          '@type': 'ContactPoint',
          contactType: 'security',
          url: 'https://github.com/ttoss/soat/security/advisories/new',
          availableLanguage: ['English'],
        },
      ],
    }),
  },
  {
    tagName: 'script',
    attributes: { type: 'application/ld+json' },
    innerHTML: JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'SOAT',
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Linux, macOS, Windows',
      description:
        'Open-source infrastructure for production-ready AI agents: IAM, storage, vector search, memory, orchestration, RAG, and a full MCP server.',
      url: 'https://soat.ttoss.dev',
      sameAs: [
        'https://github.com/ttoss/soat',
        'https://www.npmjs.com/package/@soat/cli',
        'https://hub.docker.com/r/ttoss/soat',
      ],
      isPartOf: { '@id': 'https://soat.ttoss.dev/#website' },
      license: 'https://github.com/ttoss/soat/blob/main/LICENSE',
      offers: {
        '@type': 'Offer',
        price: '0',
        priceCurrency: 'USD',
      },
      author: {
        '@type': 'Organization',
        name: 'Terezinha Tech Operations (ttoss)',
        url: 'https://ttoss.dev',
      },
    }),
  },
];
