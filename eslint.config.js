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

/**
 * The test-file ceiling, in code lines. Wider than `MODULE_CEILING`: a test
 * file legitimately carries fixture setup and one `describe` per surface, so
 * `@ttoss/eslint-config` already sizes it differently from `src` — stated
 * here, the same reason `MODULE_CEILING` is not left implicit either, now
 * that a package's `lint` script can point at `tests` and have this checked.
 */
export const TEST_MODULE_CEILING = 1000;

/**
 * Test files over the ceiling today. **This list only shrinks**, the same
 * contract `MAX_LINES_EXEMPT` holds for `src`: `tests/harness/moduleCeiling.test.mjs`
 * holds it to that. A file joins this list only by being over the ceiling
 * before `lint` first checked it — a file that grows past it afterward is a
 * new violation, not a new entry.
 */
export const TEST_MAX_LINES_EXEMPT = [
  'packages/server/tests/unit/tests/lib/agentToolResolver.test.ts',
  'packages/server/tests/unit/tests/lib/formation-modules.test.ts',
  'packages/server/tests/unit/tests/lib/formationsValidation.test.ts',
  'packages/server/tests/unit/tests/lib/orchestrationNodeExecutors.test.ts',
  'packages/server/tests/unit/tests/rest/agentGeneration.test.ts',
  'packages/server/tests/unit/tests/rest/agents.test.ts',
  'packages/server/tests/unit/tests/rest/auditLog.test.ts',
  'packages/server/tests/unit/tests/rest/conversations.test.ts',
  'packages/server/tests/unit/tests/rest/documents.test.ts',
  'packages/server/tests/unit/tests/rest/evaluations.test.ts',
  'packages/server/tests/unit/tests/rest/formations.test.ts',
  'packages/server/tests/unit/tests/rest/ingestionRules.test.ts',
  'packages/server/tests/unit/tests/rest/mcp.test.ts',
  'packages/server/tests/unit/tests/rest/orchestrationQueue.test.ts',
  'packages/server/tests/unit/tests/rest/orchestrations.test.ts',
  'packages/server/tests/unit/tests/rest/permissionsFlow.test.ts',
  'packages/server/tests/unit/tests/rest/projects.test.ts',
  'packages/server/tests/unit/tests/rest/quotas.test.ts',
  'packages/server/tests/unit/tests/rest/sessions.test.ts',
  'packages/server/tests/unit/tests/rest/tasks.test.ts',
  'packages/server/tests/unit/tests/rest/tools.test.ts',
  'packages/server/tests/unit/tests/rest/triggers.test.ts',
  'packages/server/tests/unit/tests/rest/usage.test.ts',
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
    // Source only: a test file gets the wider TEST_MODULE_CEILING below.
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
    files: ['**/tests/**/*.{js,jsx,ts,tsx}', '**/*.test.{js,jsx,ts,tsx}'],
    rules: {
      'max-lines': [
        'error',
        { max: TEST_MODULE_CEILING, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  {
    files: TEST_MAX_LINES_EXEMPT,
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
