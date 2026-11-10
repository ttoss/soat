import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');
const libDir = path.join(srcDir, 'lib');

/**
 * Both annotation bags are asked the same question on a read — does this bag
 * hold these pairs, exactly as stored — and JSONB containment is the answer.
 * `?tags=key:value` is the query-string spelling of equality on `tags`, and
 * the `metadata` filter's `eq` and `in` are the same match on `metadata`, so
 * one helper in `structuredFilter.ts` writes the fragment for both.
 *
 * A second site spelling `Op.contains` is a second matching rule: the one that
 * decides on its own whether a bag with no pairs narrows anything, whether the
 * fragment is assigned over a compiled policy or ANDed beside it, and whether
 * the operand is an object or JSON text.
 */
describe('bag containment', () => {
  /** Source with comments dropped, so prose naming the operator is not a hit. */
  const code = (file) => {
    return fs
      .readFileSync(file, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => {
        return !/^\s*(\/\/|\*)/.test(line);
      })
      .join('\n');
  };

  /**
   * `policyCompiler.ts` builds its own: a policy fragment names a column
   * reached through an association (`$document.tags$`), whose operand
   * Sequelize cannot type from the model attribute and so travels as JSON
   * text, and it carries negation and `LIKE` arms that the filter grammar has
   * no spelling for.
   *
   * `guardrailRuntimeMetrics.ts` asks array membership, not bag equality: a
   * usage event's `guardrail_ids` is a list of ids, with no pairs to match;
   * `agentPolicies.ts` the same of an agent's `policy_ids`.
   */
  const SPELLS_CONTAINMENT = [
    'agentPolicies.ts',
    'structuredFilter.ts',
    'policyCompiler.ts',
    'guardrailRuntimeMetrics.ts',
  ];

  test('one helper writes every containment fragment', () => {
    const spelling = fs
      .readdirSync(libDir, { recursive: true })
      .filter((entry) => {
        return (
          typeof entry === 'string' &&
          entry.endsWith('.ts') &&
          !SPELLS_CONTAINMENT.includes(path.basename(entry))
        );
      })
      .filter((entry) => {
        return /Op\.contains/.test(code(path.join(libDir, entry)));
      })
      .sort();

    assert.deepEqual(spelling, []);
  });

  /**
   * A range over a JSON field is only honest beside its `jsonb_typeof` guard,
   * and `compileStructuredWhere` is the one place that pairs them.
   */
  test('one compiler writes every JSON-field range', () => {
    const typed = fs
      .readdirSync(srcDir, { recursive: true })
      .filter((entry) => {
        return (
          typeof entry === 'string' &&
          entry.endsWith('.ts') &&
          path.basename(entry) !== 'structuredFilter.ts'
        );
      })
      .filter((entry) => {
        const source = code(path.join(srcDir, entry));
        return /fn:\s*'typeof'/.test(source) || /jsonb_typeof/.test(source);
      })
      .sort();

    assert.deepEqual(typed, []);
  });

  /**
   * The grammar filters any JSON column, so each caller states which one; a
   * column the compiler picked for itself would answer that once for all.
   */
  test('the compiler takes the JSON column from its caller', () => {
    const source = code(path.join(libDir, 'structuredFilter.ts'));

    assert.match(
      source,
      /export const compileStructuredWhere = \(args: \{[^}]*\battribute: string;/
    );
    assert.doesNotMatch(source, /attribute: '\w+'/);
    assert.doesNotMatch(source, /_ATTRIBUTE = '/);
  });
});
