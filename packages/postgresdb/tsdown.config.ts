import { tsdownConfig } from '@ttoss/config';

const config = tsdownConfig({
  entry: ['src/index.ts'],
});

// Remove the formatjs plugin that causes build failures in this environment
if (Array.isArray(config.plugins)) {
  config.plugins = config.plugins.filter(
    (p: { name?: string }) => p.name !== 'formatjs'
  );
}

export default config;
