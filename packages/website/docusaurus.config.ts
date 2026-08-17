import * as fs from 'node:fs';
import * as path from 'node:path';

import type * as Preset from '@docusaurus/preset-classic';
import type { Config } from '@docusaurus/types';
import { themes as prismThemes } from 'prism-react-renderer';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const buildOpenApiConfig = () => {
  const specsDir = path.resolve(__dirname, '../server/src/rest/openapi/v1');
  const files = fs.readdirSync(specsDir).filter((f) => {
    return f.endsWith('.yaml');
  });
  return Object.fromEntries(
    files.map((file) => {
      const name = path.basename(file, '.yaml');
      return [
        name,
        {
          specPath: `../server/src/rest/openapi/v1/${file}`,
          outputDir: `docs/api/${name}`,
          sidebarOptions: { groupPathsBy: 'tag' },
          hideSendButton: false,
          showInfoPage: false,
        },
      ];
    })
  );
};

const config: Config = {
  title: 'SOAT',
  tagline: 'Infrastructure for AI Apps',
  favicon: 'img/favicon.ico',

  // Future flags, see https://docusaurus.io/docs/api/docusaurus-config#future
  future: {
    v4: true, // Improve compatibility with the upcoming Docusaurus v4
  },

  // Set the production url of your site here
  url: 'https://soat.ttoss.dev',
  // Set the /<baseUrl>/ pathname under which your site is served
  // For GitHub pages deployment, it is often '/<projectName>/'
  baseUrl: '/',

  // GitHub pages deployment config.
  // If you aren't using GitHub pages, you don't need these.
  organizationName: 'ttoss', // Usually your GitHub org/user name.
  projectName: 'soat', // Usually your repo name.

  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',

  // JSON-LD structured data for richer search results.
  headTags: [
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
      tagName: 'script',
      attributes: { type: 'application/ld+json' },
      innerHTML: JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: 'SOAT',
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Linux, macOS, Windows',
        description:
          'Self-hostable infrastructure layer for production-ready AI agents: IAM, storage, vector search, memory, orchestration, RAG, and a full MCP server.',
        url: 'https://soat.ttoss.dev',
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
  ],

  // Even if you don't use internationalization, you can use this field to set
  // useful metadata like html lang. For example, if your site is Chinese, you
  // may want to replace "en" with "zh-Hans".
  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  // Render ```mermaid fenced blocks as diagrams (@docusaurus/theme-mermaid).
  markdown: {
    mermaid: true,
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          docItemComponent: '@theme/ApiItem',
          // Please change this to your repo.
          // Remove this to remove the "edit this page" links.
          editUrl: 'https://github.com/ttoss/soat/edit/main/',
          // Per-page freshness signal (from git history) for search engines
          // and AI crawlers. Requires a full clone at build time — the deploy
          // job checks out with fetch-depth: 0.
          showLastUpdateTime: true,
        },
        sitemap: {
          // Emit <lastmod> from the same git-derived last-update data, so
          // crawlers can prioritize recently changed pages.
          lastmod: 'date',
        },
        // blog: {
        //   showReadingTime: true,
        //   feedOptions: {
        //     type: ['rss', 'atom'],
        //     xslt: true,
        //   },
        //   // Please change this to your repo.
        //   // Remove this to remove the "edit this page" links.
        //   editUrl: 'https://github.com/ttoss/soat/edit/main/',
        //   // Useful options to enforce blogging best practices
        //   onInlineTags: 'warn',
        //   onInlineAuthors: 'warn',
        //   onUntruncatedBlogPosts: 'warn',
        // },
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
    [
      '@docusaurus/plugin-client-redirects',
      {
        redirects: [
          {
            from: '/docs/getting-started/advanced-config',
            to: '/docs/self-hosting/configuration',
          },
          {
            from: '/docs/getting-started/agent-system-layers',
            to: '/docs/agent-system-layers',
          },
          {
            from: '/docs/getting-started/choosing-a-client',
            to: '/docs/client-surfaces',
          },
          {
            from: '/docs/getting-started/engines-and-algorithms',
            to: '/docs/advanced/engines-and-algorithms',
          },
          {
            from: '/docs/getting-started/choosing-an-automation-model',
            to: '/docs/advanced/choosing-an-automation-model',
          },
        ],
      },
    ],
    [
      'docusaurus-plugin-openapi-docs',
      {
        id: 'api',
        docsPluginId: 'classic',
        config: buildOpenApiConfig(),
      },
    ],
    [
      'docusaurus-plugin-llms',
      {
        title: 'SOAT',
        description:
          'Infrastructure for AI Apps — Backend, identity, storage, memory, and orchestration.',
        generateLLMsTxt: true,
        // llms-full.txt is generated via customLLMFiles below so it can
        // exclude the generated API reference: the split keeps every page —
        // including all /docs/api/* operations — linkable from llms.txt (and
        // available as .md), while the full-content file stays a bounded,
        // prose-only corpus instead of ballooning with generated schema
        // markup.
        generateLLMsFullTxt: false,
        generateMarkdownFiles: true,
        excludeImports: true,
        removeDuplicateHeadings: true,
        includeOrder: [
          'getting-started/*',
          'modules/*',
          'tutorials/*',
          'sdk/*',
          'cli/*',
          'mcp/*',
          'openapi-specs.md',
        ],
        customLLMFiles: [
          {
            filename: 'llms-full.txt',
            includePatterns: ['**/*.md', '**/*.mdx'],
            fullContent: true,
            ignorePatterns: ['api/**'],
            orderPatterns: [
              'getting-started/*',
              'modules/*',
              'tutorials/*',
              'sdk/*',
              'cli/*',
              'mcp/*',
              'openapi-specs.md',
            ],
            includeUnmatchedLast: true,
            description:
              'Infrastructure for AI Apps — Backend, identity, storage, memory, and orchestration.',
          },
        ],
      },
    ],
  ],

  themes: ['docusaurus-theme-openapi-docs', '@docusaurus/theme-mermaid'],

  themeConfig: {
    // Replace with your project's social card
    image: 'img/social-card.png',
    colorMode: {
      defaultMode: 'dark',
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'SOAT',
      logo: {
        src: 'img/soat-logo-no-bg.png',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          type: 'docSidebar',
          sidebarId: 'tutorialSidebar',
          position: 'left',
          label: 'Tutorials',
        },
        {
          type: 'docSidebar',
          sidebarId: 'referenceSidebar',
          position: 'left',
          label: 'Reference',
        },
        {
          to: '/benchmark',
          label: 'Benchmark',
          position: 'left',
        },
        {
          href: 'https://github.com/ttoss/soat',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {
              label: 'Introduction',
              to: '/docs/introduction',
            },
            {
              label: 'Getting Started',
              to: '/docs/getting-started',
            },
            {
              label: 'Tutorials',
              to: '/docs/tutorials',
            },
            {
              label: 'Reference',
              to: '/docs/api',
            },
          ],
        },
        {
          title: 'Surfaces',
          items: [
            {
              label: 'REST API',
              to: '/docs/api',
            },
            {
              label: 'MCP Server',
              to: '/docs/mcp',
            },
            {
              label: 'CLI',
              to: '/docs/cli',
            },
            {
              label: 'TypeScript SDK',
              to: '/docs/sdk',
            },
          ],
        },
        {
          title: 'Community',
          items: [
            {
              label: 'GitHub Discussions',
              href: 'https://github.com/ttoss/soat/discussions',
            },
            {
              label: 'Issues',
              href: 'https://github.com/ttoss/soat/issues',
            },
          ],
        },
        {
          title: 'More',
          items: [
            {
              label: 'GitHub',
              href: 'https://github.com/ttoss/soat',
            },
            {
              label: 'Changelog',
              href: 'https://github.com/ttoss/soat/blob/main/CHANGELOG.md',
            },
            {
              label: 'License (Apache 2.0)',
              href: 'https://github.com/ttoss/soat/blob/main/LICENSE',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} SOAT, a Terezinha Tech Operations (ttoss) project.`,
    },
    // Diagrams follow the site color mode (the site defaults to dark).
    mermaid: {
      theme: { light: 'neutral', dark: 'dark' },
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.vsDark,
      additionalLanguages: ['bash', 'shell-session', 'json'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
