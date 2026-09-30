import Head from '@docusaurus/Head';
import HomepageAgentManifest from '@site/src/components/HomepageAgentManifest';
import HomepageCompare from '@site/src/components/HomepageCompare';
import HomepageDefinition from '@site/src/components/HomepageDefinition';
import HomepageFinalCta from '@site/src/components/HomepageFinalCta';
import HomepageFormations from '@site/src/components/HomepageFormations';
import HomepageHero from '@site/src/components/HomepageHero';
import HomepageLayers from '@site/src/components/HomepageLayers';
import HomepageOnboarding from '@site/src/components/HomepageOnboarding';
import HomepageSurfaces from '@site/src/components/HomepageSurfaces';
import HomepageWhenToUse from '@site/src/components/HomepageWhenToUse';
import { HOME_META } from '@site/src/data/homepage';
import Layout from '@theme/Layout';
import type * as React from 'react';

export default function Home(): React.ReactNode {
  return (
    <Layout description={HOME_META.description}>
      {/* The homepage is the only page with no Markdown twin of its own, so it
          is the one place the agent instruction file can be advertised as an
          alternate without competing with a page's own `.md` link. The edge
          function resolves `Accept: text/markdown` on `/` to this same file
          (`cloudfront/viewerRequest.js`), so what the page advertises and what
          negotiation returns are one thing. */}
      <Head>
        {/* Layout appends " | SOAT" to any title it is given; the homepage
            title already opens with the name, so it is set here whole. */}
        <title>{HOME_META.title}</title>
        <meta property="og:title" content={HOME_META.title} />
        <link
          rel="alternate"
          type="text/markdown"
          title="Agent instructions"
          href="/agents.md"
        />
      </Head>
      {/* The <h1> lives inside <main> on purpose: content extractors (and the
          AI crawlers built on them) read the main content region, and a hero
          heading parked outside it reads as a page with no heading at all. */}
      <main>
        <HomepageHero />
        <HomepageWhenToUse />
        <HomepageDefinition />
        <HomepageSurfaces />
        <HomepageFormations />
        <HomepageCompare />
        <HomepageAgentManifest />
        <HomepageLayers />
        <HomepageOnboarding />
        <HomepageFinalCta />
      </main>
    </Layout>
  );
}
