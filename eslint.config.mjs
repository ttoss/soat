import ttossEslintConfig from '@ttoss/eslint-config';

export default [
  ...ttossEslintConfig,
  {
    rules: {
      'turbo/no-undeclared-env-vars': 'off',
    },
  },
];
