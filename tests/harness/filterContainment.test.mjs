import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const libDir = path.join(repoRoot, 'packages/server/src/lib');

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
   */
  const SPELLS_CONTAINMENT = ['structuredFilter.ts', 'policyCompiler.ts'];

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
});
