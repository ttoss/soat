import ttossEslintConfig from '@ttoss/eslint-config';

export default [
  {
    ignores: ['**/src/generated/**'],
  },
  ...ttossEslintConfig,
  {
    rules: {
      'turbo/no-undeclared-env-vars': 'off',
    },
  },
];
