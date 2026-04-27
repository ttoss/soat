import { defineConfig } from '@hey-api/openapi-ts';

export default defineConfig({
  input: './merged-spec.json',
  output: {
    path: 'src/generated',
  },
  plugins: [
    '@hey-api/typescript',
    {
      name: '@hey-api/sdk',
      operations: {
        strategy: 'byTags',
      },
    },
    {
      name: '@hey-api/transformers',
      dates: true,
    },
  ],
});
