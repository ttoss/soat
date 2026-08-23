import ttossEslintConfig from '@ttoss/eslint-config';

export default [
  {
    ignores: ['**/src/generated/**'],
  },
  ...ttossEslintConfig,
  {
    /**
     * CloudFront Functions run on the `cloudfront-js-2.0` runtime: ES 5.1
     * source whose entry point has to be a hoisted `function handler(event)`
     * declaration, with `appendIndexHtml` injected into the file by carlin at
     * deploy time rather than imported.
     */
    files: ['packages/website/cloudfront/*.js'],
    languageOptions: {
      globals: {
        appendIndexHtml: 'readonly',
      },
    },
    rules: {
      'prefer-arrow-functions/prefer-arrow-functions': 'off',
    },
  },
  {
    rules: {
      'turbo/no-undeclared-env-vars': 'off',
      'formatjs/no-literal-string-in-jsx': 'off',
    },
  },
];
