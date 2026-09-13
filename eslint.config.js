import ttossEslintConfig from '@ttoss/eslint-config';

/**
 * The module ceiling, in code lines (blanks and comments not counted).
 *
 * Three modules cited "the module ceiling" as the reason for a split while the
 * number itself lived only in `@ttoss/eslint-config`, and every file over it
 * carried its own inline disable — an exemption nobody could count. Stated
 * here so the ceiling is this repo's, and the exemptions are a list.
 */
export const MODULE_CEILING = 400;

/**
 * Files over the ceiling today. **This list only shrinks.**
 * `tests/harness/moduleCeiling.test.mjs` holds it to that: an entry that no
 * longer exceeds the ceiling has to leave, a new entry fails the budget, and a
 * file turning the rule off inline fails outright — the exemption is
 * declarable here and nowhere else.
 */
export const MAX_LINES_EXEMPT = [
  'packages/server/src/errors/codes.ts',
  'packages/server/src/lib/agentNonStreamGeneration.ts',
  'packages/server/src/lib/agentToolGuardrail.ts',
  'packages/server/src/lib/agentToolResolver.ts',
  'packages/server/src/lib/approvals.ts',
  'packages/server/src/lib/orchestrationEngine.ts',
  'packages/server/src/lib/orchestrations.ts',
  'packages/website/scripts/generateCliCommandsDocs.ts',
];

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
    // Source only: a test suite runs long legitimately, and the shared config
    // already sizes those separately.
    files: ['**/*.{js,jsx,ts,tsx}'],
    ignores: ['**/tests/**', '**/*.test.{js,jsx,ts,tsx}'],
    rules: {
      'max-lines': [
        'error',
        { max: MODULE_CEILING, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  {
    files: MAX_LINES_EXEMPT,
    rules: {
      'max-lines': 'off',
    },
  },
  {
    rules: {
      'turbo/no-undeclared-env-vars': 'off',
      'formatjs/no-literal-string-in-jsx': 'off',
    },
  },
];
